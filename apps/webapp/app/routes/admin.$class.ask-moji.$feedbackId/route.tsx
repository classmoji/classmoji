import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ConfigProvider, Drawer, theme } from 'antd';
import { IconX } from '@tabler/icons-react';
import ReactMarkdown, { type Components } from 'react-markdown';

import { ClassmojiService } from '@classmoji/services';
import { useDarkMode } from '~/hooks';
import {
  INSIGHT_AUDIT_TOOLS,
  requireAskMojiInsights,
} from '../admin.$class.ask-moji/insights.server';
import { ROLE_LABEL, toExchangeView } from '../admin.$class.ask-moji/insightsView';
import type { Route } from './+types/route';

/**
 * One rated Ask Moji exchange, read-only: the question and the rated answer,
 * as the asker saw them. Opened from the insights page's feedback review;
 * `/teacher/:class/ask-moji/:feedbackId` re-exports this route.
 *
 * The same gate as the page (OWNER or TEACHER, 404 where Ask Moji is not
 * available). The service finds the rating only in this classroom and only
 * when the viewer may see it (a staff exchange only when it was asked as a
 * role at or below the viewer's); anything else is 404. Each open is a VIEW
 * row with `resource_id` = the feedback id.
 */
export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const access = await requireAskMojiInsights(request, params.class!, 'view_exchange');

  const exchange = await ClassmojiService.askMojiInsights.exchange({
    classroomId: access.classroomId,
    viewerRole: access.viewerRole,
    feedbackId: params.feedbackId!,
  });
  if (!exchange) throw new Response('Not Found', { status: 404 });

  await access.audit({
    resourceType: 'ASK_MOJI_FEEDBACK',
    resourceId: exchange.feedbackId,
    tool: INSIGHT_AUDIT_TOOLS.exchange,
    data: { asker_id: exchange.asker.userId },
  });

  return { exchange: toExchangeView(exchange, access.timeZone) };
};

/** The answer's Markdown, styled for light and dark; images show as their alt text. */
const markdown: Components = {
  p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc pl-5 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal pl-5 space-y-1">{children}</ol>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 underline hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
    >
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="italic text-gray-500">{alt}</span>,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-stone-100 p-3 text-xs dark:bg-neutral-800">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded-sm bg-stone-100 px-1 py-0.5 text-[0.85em] dark:bg-neutral-800">
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-stone-200 px-2 py-1 text-left dark:border-neutral-700">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-stone-200 px-2 py-1 dark:border-neutral-700">{children}</td>
  ),
};

const Block = ({ label, children }: { label: string; children: ReactNode }) => (
  <section className="mb-6">
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {label}
    </h3>
    {children}
  </section>
);

const AskMojiExchange = ({ loaderData }: Route.ComponentProps) => {
  const { exchange } = loaderData;
  const { isDarkMode } = useDarkMode();
  const navigate = useNavigate();
  const { search } = useLocation();

  // Back to the list, with its filter; never history.back(), so a direct link
  // closes onto the insights page rather than out of the app.
  const close = () => navigate({ pathname: '..', search }, { preventScrollReset: true });

  return (
    <ConfigProvider
      theme={{ algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <Drawer
        open
        onClose={close}
        width="min(720px, 100vw)"
        closeIcon={<IconX className="text-ink-1" size={18} />}
        title={
          <span>
            {exchange.rating === 'DOWN' ? '👎' : '👍'} {exchange.askerName}
          </span>
        }
      >
        <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
          {exchange.askerRole !== ROLE_LABEL.STUDENT && (
            <span className="rounded-sm bg-stone-100 px-1.5 py-0.5 dark:bg-neutral-800">
              {exchange.askerRole}
            </span>
          )}
          <span>{exchange.when}</span>
          {exchange.viewing && (
            <span>
              Viewing {exchange.viewing.kind}: {exchange.viewing.title}
              {exchange.viewing.detail ? ` · ${exchange.viewing.detail}` : ''}
            </span>
          )}
        </div>

        <Block label="Question">
          <div className="whitespace-pre-wrap rounded-lg bg-stone-50 p-3 text-sm text-gray-800 dark:bg-neutral-800/60 dark:text-gray-200">
            {exchange.question}
          </div>
        </Block>

        <Block label="Answer">
          <div className="text-sm text-gray-800 dark:text-gray-200" data-testid="ask-moji-answer">
            <ReactMarkdown skipHtml components={markdown}>
              {exchange.answer}
            </ReactMarkdown>
          </div>
        </Block>

        {exchange.sources.length > 0 && (
          <Block label="Sources">
            <ul className="space-y-1 text-sm">
              {exchange.sources.map(source => (
                <li key={`${source.title}\n${source.url ?? ''}`}>
                  {source.url ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
                    >
                      {source.title}
                    </a>
                  ) : (
                    <span className="text-gray-700 dark:text-gray-300">{source.title}</span>
                  )}
                </li>
              ))}
            </ul>
          </Block>
        )}

        {exchange.steps.length > 0 && (
          <Block
            label={`Looked at ${exchange.steps.length} ${exchange.steps.length === 1 ? 'thing' : 'things'}`}
          >
            <ul className="space-y-1 text-sm text-gray-600 dark:text-gray-400">
              {exchange.steps.map((step, i) => (
                <li key={`${i}:${step}`}>{step}</li>
              ))}
            </ul>
          </Block>
        )}
      </Drawer>
    </ConfigProvider>
  );
};

export default AskMojiExchange;
