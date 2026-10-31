/**
 * GET /ask-moji/:class/embed?parentOrigin=<origin> — the Ask Moji panel
 * alone, for the pages and slides apps to frame (R1). The root renders
 * nothing else around it on this path. See ./embed.server.ts for the framing
 * policy and the loader's states, and the panel's protocol in
 * components/features/ask-moji/protocol.ts.
 */
import AskMojiEmbed from '~/components/features/ask-moji/AskMojiEmbed';
import { embedHeaders, loadEmbed } from './embed.server';
import type { Route } from './+types/route';

export const meta = () => [{ title: 'Ask Moji' }];

export const headers = () => embedHeaders();

export async function loader({ request, params }: Route.LoaderArgs) {
  return loadEmbed(request, params.class);
}

export default function AskMojiEmbedRoute({ loaderData }: Route.ComponentProps) {
  return <AskMojiEmbed data={loaderData} />;
}
