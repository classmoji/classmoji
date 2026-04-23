import { useState } from 'react';
import { toast } from 'react-toastify';

import { useGlobalFetcher } from '~/hooks';

export interface EmojiGradeRecord {
  emoji: string;
  grade: number;
  extra_tokens: number;
  description: string;
}

interface EmojiGradeEditorProps {
  emojiMappings: EmojiGradeRecord[];
}

const GRID = '60px 1fr 80px 80px 40px';

function letterForPct(pct: number): string {
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 70) return 'C';
  if (pct >= 60) return 'D';
  return 'F';
}

export function EmojiGradeEditor({ emojiMappings }: EmojiGradeEditorProps) {
  const { notify, fetcher } = useGlobalFetcher();
  const [editing, setEditing] = useState<{ emoji: string; field: 'grade' | 'description' } | null>(
    null
  );
  const [editValue, setEditValue] = useState<string>('');

  const sorted = [...emojiMappings].sort((a, b) => b.grade - a.grade);

  const saveCell = (record: EmojiGradeRecord, field: 'grade' | 'description', raw: string) => {
    const next = {
      emoji: record.emoji,
      grade: field === 'grade' ? parseFloat(raw) || 0 : record.grade,
      extra_tokens: record.extra_tokens,
      description: field === 'description' ? raw : record.description,
    };
    fetcher!.submit(next, {
      action: '?/saveEmojiToGradeMapping',
      method: 'POST',
      encType: 'application/json',
    });
    setEditing(null);
    setEditValue('');
  };

  const deleteMapping = (record: EmojiGradeRecord) => {
    notify('Deleting emoji mapping...');
    fetcher!.submit(
      { emoji: record.emoji },
      {
        action: '?/deleteEmojiToGradeMapping',
        method: 'DELETE',
        encType: 'application/json',
      }
    );
  };

  const populateDefaults = () => {
    if (
      emojiMappings.length > 0 &&
      !confirm('Reset to defaults? This will remove all existing mappings and add the defaults.')
    ) {
      return;
    }
    notify('Adding default emoji mappings...');
    fetcher!.submit(
      {},
      {
        action: '?/populateDefaultMappings',
        method: 'POST',
        encType: 'application/json',
      }
    );
  };

  // Quick add state
  const [newEmoji, setNewEmoji] = useState('');
  const [newGrade, setNewGrade] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const createMapping = () => {
    if (!newEmoji || !newGrade) {
      return toast.error('Please enter an emoji and a numeric grade (0-100).');
    }
    const pct = parseFloat(newGrade);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      return toast.error('Grade must be a number between 0 and 100.');
    }
    notify('Creating emoji mapping...');
    fetcher!.submit(
      {
        emoji: newEmoji.trim(),
        grade: pct,
        extra_tokens: 0,
        description: newDesc,
      },
      {
        action: '?/saveEmojiToGradeMapping',
        method: 'POST',
        encType: 'application/json',
      }
    );
    setNewEmoji('');
    setNewGrade('');
    setNewDesc('');
  };

  return (
    <div className="card" style={{ padding: 24 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 10,
          gap: 12,
        }}
      >
        <div className="caps">Grade scale</div>
        <button
          type="button"
          className="btn"
          onClick={populateDefaults}
          style={{ fontSize: 12 }}
        >
          Reset to defaults
        </button>
      </div>
      <p style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 0, maxWidth: 520 }}>
        Map emoji to numeric grades. Students see the emoji on their work; these map to percentages
        for GPA calculations.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
        {sorted.length === 0 ? (
          <div
            style={{
              padding: '28px 10px',
              textAlign: 'center',
              color: 'var(--ink-3)',
              fontSize: 13,
              border: '1px dashed var(--line)',
              borderRadius: 10,
            }}
          >
            No emoji mappings yet. Add one below or reset to defaults.
          </div>
        ) : (
          sorted.map(g => {
            const editingGrade = editing?.emoji === g.emoji && editing.field === 'grade';
            const editingDesc = editing?.emoji === g.emoji && editing.field === 'description';
            return (
              <div
                key={g.emoji}
                style={{
                  display: 'grid',
                  gridTemplateColumns: GRID,
                  gap: 16,
                  alignItems: 'center',
                  padding: 10,
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                }}
              >
                <span style={{ fontSize: 28, textAlign: 'center' }}>{g.emoji}</span>
                {editingDesc ? (
                  <input
                    autoFocus
                    className="input"
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={() => saveCell(g, 'description', editValue)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveCell(g, 'description', editValue);
                      if (e.key === 'Escape') {
                        setEditing(null);
                        setEditValue('');
                      }
                    }}
                    style={{
                      fontSize: 14,
                      fontWeight: 500,
                      border: '1px solid var(--line-2)',
                      borderRadius: 6,
                      padding: '4px 8px',
                      background: 'transparent',
                      color: 'var(--ink-0)',
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing({ emoji: g.emoji, field: 'description' });
                      setEditValue(g.description || '');
                    }}
                    style={{
                      textAlign: 'left',
                      fontSize: 14,
                      fontWeight: 500,
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'text',
                      color: g.description ? 'var(--ink-0)' : 'var(--ink-3)',
                    }}
                  >
                    {g.description || 'Add label…'}
                  </button>
                )}
                {editingGrade ? (
                  <input
                    autoFocus
                    type="number"
                    min={0}
                    max={100}
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={() => saveCell(g, 'grade', editValue)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') saveCell(g, 'grade', editValue);
                      if (e.key === 'Escape') {
                        setEditing(null);
                        setEditValue('');
                      }
                    }}
                    className="mono"
                    style={{
                      fontSize: 13,
                      border: '1px solid var(--line-2)',
                      borderRadius: 6,
                      padding: '4px 8px',
                      background: 'transparent',
                      color: 'var(--ink-0)',
                      width: 70,
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="mono"
                    onClick={() => {
                      setEditing({ emoji: g.emoji, field: 'grade' });
                      setEditValue(String(g.grade));
                    }}
                    style={{
                      fontSize: 13,
                      color: 'var(--ink-2)',
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'text',
                      textAlign: 'left',
                    }}
                  >
                    {g.grade}%
                  </button>
                )}
                <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{letterForPct(g.grade)}</span>
                <button
                  type="button"
                  onClick={() => deleteMapping(g)}
                  aria-label={`Remove ${g.emoji}`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--ink-3)',
                    cursor: 'pointer',
                    fontSize: 16,
                    padding: 4,
                    lineHeight: 1,
                  }}
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      <div
        style={{
          marginTop: 16,
          paddingTop: 16,
          borderTop: '1px dashed var(--line)',
          display: 'grid',
          gridTemplateColumns: GRID,
          gap: 16,
          alignItems: 'center',
        }}
      >
        <input
          type="text"
          placeholder="😀"
          value={newEmoji}
          onChange={e => setNewEmoji(e.target.value)}
          maxLength={8}
          style={{
            fontSize: 22,
            textAlign: 'center',
            border: '1px solid var(--line-2)',
            borderRadius: 8,
            padding: '6px 8px',
            background: 'transparent',
            color: 'var(--ink-0)',
          }}
        />
        <input
          type="text"
          placeholder="Label (e.g. Excellent)"
          value={newDesc}
          onChange={e => setNewDesc(e.target.value)}
          style={{
            fontSize: 14,
            border: '1px solid var(--line-2)',
            borderRadius: 8,
            padding: '6px 10px',
            background: 'transparent',
            color: 'var(--ink-0)',
          }}
        />
        <input
          type="number"
          min={0}
          max={100}
          placeholder="95"
          value={newGrade}
          onChange={e => setNewGrade(e.target.value)}
          className="mono"
          style={{
            fontSize: 13,
            border: '1px solid var(--line-2)',
            borderRadius: 8,
            padding: '6px 10px',
            background: 'transparent',
            color: 'var(--ink-0)',
            width: 70,
          }}
        />
        <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          {newGrade ? letterForPct(parseFloat(newGrade) || 0) : '—'}
        </span>
        <button
          type="button"
          className="btn btn-primary"
          onClick={createMapping}
          style={{ fontSize: 12, padding: '6px 10px' }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

export default EmojiGradeEditor;
