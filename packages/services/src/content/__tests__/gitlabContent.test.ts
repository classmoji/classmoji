import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../../classmoji/gitlabConnection.service.ts', () => ({
  getConnectionToken: async () => 'tok',
}));

const { ContentService } = await import('../ContentService.ts');
const { gitBlobSha } = await import('../gitlabContent.ts');

/**
 * A tiny in-memory Gitlab: one project, branches as file maps, commits as ids.
 * Enough of the files, tree, branches, commits, compare and merge_base
 * endpoints to drive ContentService's Gitlab path end to end.
 */
class FakeGitLab {
  branches = new Map<string, { head: string; files: Map<string, FakeFile> }>();
  commits = new Map<string, Map<string, FakeFile>>();
  parents = new Map<string, string[]>();
  mrs = new Map<number, { source: string; target: string; state: string }>();
  n = 0;

  constructor(files: Record<string, string>) {
    const map = new Map<string, FakeFile>();
    const id = this.#commitId();
    for (const [path, text] of Object.entries(files)) {
      map.set(path, { bytes: Buffer.from(text), lastCommit: id });
    }
    this.commits.set(id, map);
    this.parents.set(id, []);
    this.branches.set('main', { head: id, files: map });
  }

  #commitId() {
    this.n += 1;
    return `c${String(this.n).padStart(39, '0')}`;
  }

  #snapshot(ref: string) {
    return this.branches.get(ref)?.files ?? this.commits.get(ref) ?? null;
  }

  #ancestors(id: string) {
    const out = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const c = queue.shift()!;
      if (out.has(c)) continue;
      out.add(c);
      queue.push(...(this.parents.get(c) ?? []));
    }
    return out;
  }

  /** The newest common ancestor (commit ids sort by creation). */
  #mergeBase(a: string, b: string) {
    const seen = this.#ancestors(a);
    const common = [...this.#ancestors(b)].filter(c => seen.has(c)).sort();
    return common.at(-1) ?? null;
  }

  /** Paths whose bytes differ between two snapshots. */
  #changed(before: Map<string, FakeFile>, after: Map<string, FakeFile>) {
    const out: string[] = [];
    for (const p of new Set([...before.keys(), ...after.keys()])) {
      const x = before.get(p);
      const y = after.get(p);
      if (!(x && y && x.bytes.equals(y.bytes))) out.push(p);
    }
    return out;
  }

  #headOf(ref: string) {
    return this.branches.get(ref)?.head ?? ref;
  }

  handle = async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const path = decodeURIComponent(u.pathname.replace(/^\/api\/v4\/projects\/[^/]+/, ''));
    const q = u.searchParams;

    if (path === '' && method === 'GET') return json(200, { default_branch: 'main' });

    let m = path.match(/^\/repository\/files\/(.+)$/);
    if (m) {
      const files = this.#snapshot(q.get('ref') ?? 'main');
      const file = files?.get(m[1]!);
      if (!file) return json(404, { message: '404 File Not Found' });
      if (method === 'HEAD') {
        return json(200, null, {
          'x-gitlab-blob-id': gitBlobSha(file.bytes),
          'x-gitlab-size': String(file.bytes.length),
          'x-gitlab-last-commit-id': file.lastCommit,
        });
      }
      return json(200, { content: file.bytes.toString('base64'), blob_id: gitBlobSha(file.bytes) });
    }

    m = path.match(/^\/repository\/blobs\/([^/]+)\/raw$/);
    if (m) {
      for (const files of this.commits.values()) {
        for (const file of files.values()) {
          if (gitBlobSha(file.bytes) === m[1]) return raw(200, file.bytes);
        }
      }
      return json(404, { message: '404 Blob Not Found' });
    }

    if (path === '/repository/tree') {
      const files = this.#snapshot(q.get('ref') ?? 'main')!;
      const prefix = q.get('path') ? `${q.get('path')}/` : '';
      const recursive = q.get('recursive') === 'true';
      const out = new Map<string, { id: string; name: string; path: string; type: string }>();
      for (const [p, f] of files) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (recursive || !rest.includes('/')) {
          out.set(p, { id: gitBlobSha(f.bytes), name: p.split('/').pop()!, path: p, type: 'blob' });
        } else {
          const dir = prefix + rest.split('/')[0];
          out.set(dir, { id: `tree-${dir}`, name: rest.split('/')[0]!, path: dir, type: 'tree' });
        }
      }
      if (prefix && out.size === 0) return json(404, { message: '404 Tree Not Found' });
      return json(200, [...out.values()]);
    }

    m = path.match(/^\/repository\/branches(?:\/(.+))?$/);
    if (m) {
      if (method === 'POST') {
        const body = JSON.parse(init.body!);
        const files = new Map(this.commits.get(body.ref)!);
        this.branches.set(body.branch, { head: body.ref, files });
        return json(201, { commit: { id: body.ref } });
      }
      const branch = this.branches.get(m[1]!);
      if (!branch) return json(404, { message: '404 Branch Not Found' });
      if (method === 'DELETE') {
        this.branches.delete(m[1]!);
        return json(204, null);
      }
      return json(200, { commit: { id: branch.head } });
    }

    if (path === '/repository/commits' && method === 'POST') {
      const body = JSON.parse(init.body!);
      const branch = this.branches.get(body.branch)!;
      const next = new Map(branch.files);
      const id = this.#commitId();
      for (const a of body.actions) {
        const current = next.get(a.file_path);
        if (a.action === 'create' && current) {
          return json(400, { message: 'A file with this name already exists' });
        }
        if ((a.action === 'update' || a.action === 'delete') && !current) {
          return json(400, { message: "A file with this name doesn't exist" });
        }
        if (a.last_commit_id && current && current.lastCommit !== a.last_commit_id) {
          return json(400, {
            message:
              'You are attempting to update a file that has changed since you started editing it.',
          });
        }
        if (a.action === 'delete') next.delete(a.file_path);
        else next.set(a.file_path, { bytes: Buffer.from(a.content, 'base64'), lastCommit: id });
      }
      this.commits.set(id, next);
      this.parents.set(id, [branch.head]);
      this.branches.set(body.branch, { head: id, files: next });
      return json(201, { id });
    }

    if (path === '/repository/merge_base') {
      const [a, b] = q.getAll('refs[]');
      return json(200, { id: this.#mergeBase(a!, b!) });
    }

    if (path === '/repository/compare') {
      const from = this.#headOf(q.get('from')!);
      const to = this.#headOf(q.get('to')!);
      const base = this.#mergeBase(from, to)!;
      const reachable = this.#ancestors(from);
      const commits = [...this.#ancestors(to)]
        .filter(c => !reachable.has(c))
        .sort()
        .map(id => ({ id }));
      const before = this.commits.get(base)!;
      const after = this.commits.get(to)!;
      const diffs = this.#changed(before, after).map(p => ({
        old_path: p,
        new_path: p,
        new_file: !before.has(p),
        deleted_file: !after.has(p),
        renamed_file: false,
      }));
      return json(200, { commits, diffs });
    }

    if (path === '/merge_requests' && method === 'POST') {
      const body = JSON.parse(init.body!);
      const iid = this.mrs.size + 1;
      this.mrs.set(iid, {
        source: body.source_branch,
        target: body.target_branch,
        state: 'opened',
      });
      return json(201, { iid, detailed_merge_status: 'checking' });
    }

    m = path.match(/^\/merge_requests\/(\d+)(\/merge)?$/);
    if (m) {
      const mr = this.mrs.get(Number(m[1]))!;
      const target = this.branches.get(mr.target)!;
      const source = this.branches.get(mr.source)!;
      const base = this.commits.get(this.#mergeBase(target.head, source.head)!)!;
      const ours = this.#changed(base, target.files);
      const theirs = this.#changed(base, source.files);
      const conflict = theirs.some(p => ours.includes(p));
      if (!m[2] && method === 'GET') {
        return json(200, {
          iid: Number(m[1]),
          has_conflicts: conflict,
          detailed_merge_status: conflict ? 'conflict' : 'mergeable',
        });
      }
      if (!m[2] && method === 'PUT') {
        mr.state = JSON.parse(init.body!).state_event === 'close' ? 'closed' : mr.state;
        return json(200, { iid: Number(m[1]) });
      }
      if (conflict) return json(406, { message: 'Branch cannot be merged' });
      const files = new Map(target.files);
      for (const p of theirs) {
        const f = source.files.get(p);
        if (f) files.set(p, f);
        else files.delete(p);
      }
      const id = this.#commitId();
      this.commits.set(id, files);
      this.parents.set(id, [target.head, source.head]);
      this.branches.set(mr.target, { head: id, files });
      mr.state = 'merged';
      return json(200, { iid: Number(m[1]), merge_commit_sha: id });
    }

    return json(500, { message: `fake gitlab: unhandled ${method} ${path}` });
  };
}

interface FakeFile {
  bytes: Buffer;
  lastCommit: string;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = body === null ? '' : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => Buffer.from(text),
  };
}

function raw(status: number, bytes: Buffer) {
  return {
    ok: true,
    status,
    headers: new Headers(),
    text: async () => bytes.toString(),
    arrayBuffer: async () => bytes,
  };
}

const gitOrganization = {
  provider: 'GITLAB',
  login: 'dept',
  provider_id: '1',
  access_token: 'tok',
};
const repo = 'content-cs1';

let gitlab: FakeGitLab;

beforeEach(() => {
  gitlab = new FakeGitLab({ 'pages/a/content.json': '{"v":1}', 'img/x.png': 'PNG' });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: { method?: string; body?: string }) => gitlab.handle(url, init))
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('gitBlobSha', () => {
  it('is the id git gives the same bytes', () => {
    // `printf hello | git hash-object --stdin`
    expect(gitBlobSha(Buffer.from('hello'))).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
    const manual = createHash('sha1').update('blob 0\0').digest('hex');
    expect(gitBlobSha(Buffer.alloc(0))).toBe(manual);
  });
});

describe('ContentService on a Gitlab content project', () => {
  it('reads content and metadata with git blob ids', async () => {
    const file = await ContentService.getContent({
      gitOrganization,
      repo,
      path: 'pages/a/content.json',
      skipCache: true,
    });
    expect(file).toEqual({ content: '{"v":1}', sha: gitBlobSha(Buffer.from('{"v":1}')) });

    const meta = await ContentService.getMeta({
      gitOrganization,
      repo,
      path: 'pages/a/content.json',
      skipCache: true,
    });
    expect(meta?.sha).toBe(file?.sha);
    expect(
      await ContentService.getMeta({ gitOrganization, repo, path: 'nope', skipCache: true })
    ).toBeNull();
  });

  it('writes with a compare-and-swap on the blob id', async () => {
    const before = gitBlobSha(Buffer.from('{"v":1}'));
    const written = await ContentService.put({
      gitOrganization,
      repo,
      path: 'pages/a/content.json',
      content: '{"v":2}',
      expectedSha: before,
    });
    expect(written.sha).toBe(gitBlobSha(Buffer.from('{"v":2}')));
    expect(written.commit).toMatch(/^c/);

    await expect(
      ContentService.put({
        gitOrganization,
        repo,
        path: 'pages/a/content.json',
        content: '{"v":3}',
        expectedSha: before,
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a create-only write onto an existing file with a 409', async () => {
    await expect(
      ContentService.put({
        gitOrganization,
        repo,
        path: 'pages/a/content.json',
        content: 'x',
        createOnly: true,
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('uploads a batch as one commit, creating and updating', async () => {
    const result = await ContentService.uploadBatch({
      gitOrganization,
      repo,
      files: [
        { path: 'pages/a/content.json', content: '{"v":9}' },
        {
          path: 'pages/a/assets/b.png',
          content: Buffer.from('B').toString('base64'),
          encoding: 'base64',
        },
      ],
    });
    expect(result.filesUploaded).toBe(2);
    expect(result.files[1]!.sha).toBe(gitBlobSha(Buffer.from('B')));
    const main = gitlab.branches.get('main')!;
    expect(main.files.get('pages/a/assets/b.png')!.bytes.toString()).toBe('B');
    expect(gitlab.parents.get(main.head)).toEqual(['c' + '1'.padStart(39, '0')]);
  });

  it('lists folders and deletes them in one commit', async () => {
    const list = await ContentService.listFolder({
      gitOrganization,
      repo,
      path: 'pages',
      skipCache: true,
    });
    expect(list).toEqual([{ name: 'a', path: 'pages/a', type: 'dir', sha: 'tree-pages/a' }]);

    const deleted = await ContentService.deleteFolder({ gitOrganization, repo, path: 'pages/a' });
    expect(deleted.filesDeleted).toBe(1);
    expect(gitlab.branches.get('main')!.files.has('pages/a/content.json')).toBe(false);
  });

  it('merges a preview branch cleanly, and reports a conflict when both sides changed a file', async () => {
    const mainHead = gitlab.branches.get('main')!.head;
    await ContentService.createBranch({
      gitOrganization,
      repo,
      branch: 'preview/p',
      fromSha: mainHead,
    });
    await ContentService.put({
      gitOrganization,
      repo,
      path: 'pages/a/content.json',
      content: '{"v":"preview"}',
      branch: 'preview/p',
    });

    const compare = await ContentService.compareBranches({
      gitOrganization,
      repo,
      base: 'main',
      head: 'preview/p',
    });
    expect(compare).toMatchObject({
      ahead_by: 1,
      behind_by: 0,
      base_sha: mainHead,
      merge_base_sha: mainHead,
    });

    const merged = await ContentService.mergeBranch({
      gitOrganization,
      repo,
      base: 'main',
      head: 'preview/p',
    });
    expect(merged.merged).toBe(true);
    expect(gitlab.branches.get('main')!.files.get('pages/a/content.json')!.bytes.toString()).toBe(
      '{"v":"preview"}'
    );
    // A real merge: the preview's commits are now in main's history, which is
    // how accept decides the preview is fully merged and deletes it.
    expect(
      await ContentService.compareBranches({
        gitOrganization,
        repo,
        base: 'main',
        head: 'preview/p',
      })
    ).toMatchObject({ ahead_by: 0 });
    expect([...gitlab.mrs.values()][0]!.state).toBe('merged');

    // Now both sides edit the same file.
    const head2 = gitlab.branches.get('main')!.head;
    await ContentService.createBranch({
      gitOrganization,
      repo,
      branch: 'preview/q',
      fromSha: head2,
    });
    await ContentService.put({
      gitOrganization,
      repo,
      path: 'pages/a/content.json',
      content: 'theirs',
      branch: 'preview/q',
    });
    await ContentService.put({
      gitOrganization,
      repo,
      path: 'pages/a/content.json',
      content: 'ours',
    });
    const conflicted = await ContentService.mergeBranch({
      gitOrganization,
      repo,
      base: 'main',
      head: 'preview/q',
    });
    expect(conflicted).toEqual({ merged: false, conflict: true });
    expect([...gitlab.mrs.values()][1]!.state).toBe('closed');
  });

  it('reports a missing branch as null from compareBranches', async () => {
    expect(
      await ContentService.compareBranches({
        gitOrganization,
        repo,
        base: 'main',
        head: 'preview/none',
      })
    ).toBeNull();
  });
});
