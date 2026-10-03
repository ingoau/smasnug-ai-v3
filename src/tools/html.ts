/** HTML → readable markdown: Readability (on a linkedom DOM) picks the main content, Turndown converts it. */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'form', 'button'] as any);
// Images add noise and tokens; keep alt text only.
turndown.addRule('img', { filter: 'img', replacement: (_c, node: any) => (node.getAttribute?.('alt') ? `[image: ${node.getAttribute('alt')}]` : '') });

export interface PageText {
  title?: string;
  byline?: string;
  markdown: string;
}

export function htmlToMarkdown(html: string, baseUrl?: string): PageText {
  const { document } = parseHTML(html);
  if (baseUrl) absolutizeLinks(document, baseUrl);
  const title = document.querySelector('title')?.textContent?.trim() || undefined;
  let article: ReturnType<Readability['parse']> = null;
  try {
    // Readability mutates the document; it's ours to throw away.
    article = new Readability(document as any, { charThreshold: 200 }).parse();
  } catch {
    article = null;
  }
  const contentHtml = article?.content || document.body?.innerHTML || html;
  const markdown = cleanup(turndown.turndown(contentHtml));
  return { title: article?.title?.trim() || title, byline: article?.byline?.trim() || undefined, markdown };
}

function absolutizeLinks(document: any, baseUrl: string) {
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    try {
      a.setAttribute('href', new URL(href, baseUrl).toString());
    } catch {
      /* leave as is */
    }
  }
}

function cleanup(md: string) {
  return md
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
