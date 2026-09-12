/**
 * Steam community guides as a text corpus.
 *
 * Steam's API publishes guide metadata but not bodies, so the text is read from
 * the rendered page. HTMLRewriter parses in the runtime rather than in
 * JavaScript, which keeps the work inside the free plan's 10ms of CPU.
 */

interface GuideSection {
  title: string;
  text: string;
}

export interface Guide {
  id: string;
  title: string;
  author: string;
  url: string;
  sections: GuideSection[];
}

const COMMUNITY = "https://steamcommunity.com";

/** Past this, a guide section is a screenshot gallery. */
const MAX_SECTION_CHARS = 4000;

const FETCH_HEADERS = {
  // Steam serves a trimmed page to clients it does not recognise as browsers.
  "User-Agent": "Mozilla/5.0 (compatible; histlow-achievements/0.2)",
  "Accept-Language": "es,en;q=0.8",
};

function guideUrl(id: string): string {
  return `${COMMUNITY}/sharedfiles/filedetails/?id=${id}`;
}

/** A game's achievement guides, best rated first. Both filters were verified to change the results. */
export async function fetchGuideIds(appId: number, limit: number): Promise<string[]> {
  return guideIdsFrom(
    `${COMMUNITY}/app/${appId}/guides/?browsefilter=toprated&requiredtags%5B%5D=Achievements`,
    limit,
  );
}

/**
 * Guides about one achievement, found by its name, for games whose top guides
 * are route walkthroughs that never name one. `searchText` was verified to filter.
 */
export async function fetchGuideIdsFor(
  appId: number,
  achievementName: string,
  limit: number,
): Promise<string[]> {
  return guideIdsFrom(
    `${COMMUNITY}/app/${appId}/guides/` +
      `?browsefilter=toprated&searchText=${encodeURIComponent(achievementName)}`,
    limit,
  );
}

async function guideIdsFrom(url: string, limit: number): Promise<string[]> {
  const response = await fetch(url, { headers: FETCH_HEADERS });
  if (!response.ok) return [];

  const ids: string[] = [];
  const seen = new Set<string>();

  await new HTMLRewriter()
    .on("a", {
      element(element) {
        if (ids.length >= limit) return;
        const href = element.getAttribute("href");
        const match = href && /filedetails\/\?id=(\d{6,})/.exec(href);
        if (match?.[1] && !seen.has(match[1])) {
          seen.add(match[1]);
          ids.push(match[1]);
        }
      },
    })
    .transform(response)
    .body?.pipeTo(new WritableStream());

  return ids;
}

/**
 * One guide, flattened to titled sections of plain text. Images are dropped, and
 * a section left with no text is not kept.
 */
export async function fetchGuide(id: string): Promise<Guide | null> {
  const response = await fetch(guideUrl(id), { headers: FETCH_HEADERS });
  if (!response.ok) return null;

  const sections: GuideSection[] = [];
  let title = "";
  let author = "";
  let pendingTitle: string | null = null;
  let body = "";
  let truncated = false;

  const flush = () => {
    if (pendingTitle === null) return;
    const text = collapse(body);
    if (text.length > 0) sections.push({ title: collapse(pendingTitle), text });
    pendingTitle = null;
    body = "";
  };

  await new HTMLRewriter()
    .on("div.workshopItemTitle", {
      text(chunk) {
        title += chunk.text;
      },
    })
    .on("div.friendBlockContent", {
      text(chunk) {
        author += chunk.text;
      },
    })
    .on("div.subSectionTitle", {
      element() {
        flush();
        pendingTitle = "";
      },
      text(chunk) {
        if (pendingTitle !== null) pendingTitle += chunk.text;
      },
    })
    .on("div.subSectionDesc", {
      text(chunk) {
        if (truncated) return;
        body += chunk.text;
        if (body.length > MAX_SECTION_CHARS) {
          body = body.slice(0, MAX_SECTION_CHARS);
          truncated = true;
        }
      },
      element() {
        truncated = false;
      },
    })
    .transform(response)
    .body?.pipeTo(new WritableStream());

  flush();

  if (sections.length === 0) return null;

  return {
    id,
    title: collapse(title) || `Guide ${id}`,
    // The block is the author's name, then their online status on its own line.
    author: collapse(author.split("\n").find((line) => line.trim().length > 0) ?? "") || "Unknown author",
    url: guideUrl(id),
    sections,
  };
}

export interface Passage {
  guideId: string;
  guideTitle: string;
  guideUrl: string;
  author: string;
  section: string;
  text: string;
  score: number;
}

/** Characters of context kept either side of the mention. */
const LEAD = 350;
const TRAIL = 1100;

/**
 * The passages of a corpus that discuss one achievement.
 *
 * The achievement's name is the strongest signal, and it survives translation:
 * Steam keeps names in English even inside a Russian guide. A section that
 * scores nothing is dropped, because unrelated prose is what makes a model
 * invent steps.
 */
export function findPassages(
  guides: Guide[],
  name: string,
  description: string,
  max: number,
  options: {
    /** A guide whose title names the achievement is about it throughout, without repeating it. */
    guideTitleQualifies?: boolean;
  } = {},
): Passage[] {
  const needle = name.toLowerCase();
  const keywords = distinctiveWords(description);
  const found: Passage[] = [];

  for (const guide of guides) {
    const wholeGuideQualifies =
      options.guideTitleQualifies === true && guide.title.toLowerCase().includes(needle);

    for (const section of guide.sections) {
      const haystack = section.text.toLowerCase();
      const inTitle = section.title.toLowerCase().includes(needle);
      const at = haystack.indexOf(needle);

      let score = 0;
      if (inTitle) score += 40;
      if (at >= 0) score += 20 + Math.min(occurrences(haystack, needle) - 1, 3) * 5;
      if (wholeGuideQualifies) score += 15;
      // Keywords only rank passages that already name the achievement.
      if (score > 0) {
        score += keywords.filter((word) => haystack.includes(word)).length;
      }
      if (score === 0) continue;

      found.push({
        guideId: guide.id,
        guideTitle: guide.title,
        guideUrl: guide.url,
        author: guide.author,
        section: section.title,
        text: window(section.text, at),
        score,
      });
    }
  }

  found.sort((a, b) => b.score - a.score);

  // One passage per guide first, so one rambling walkthrough cannot crowd out other authors.
  const perGuide = new Set<string>();
  const primary = found.filter((passage) => {
    if (perGuide.has(passage.guideId)) return false;
    perGuide.add(passage.guideId);
    return true;
  });
  return [...primary, ...found.filter((p) => !primary.includes(p))].slice(0, max);
}

function window(text: string, at: number): string {
  if (at < 0) return text.slice(0, LEAD + TRAIL);
  const start = Math.max(0, at - LEAD);
  const slice = text.slice(start, at + TRAIL);
  return (start > 0 ? "… " : "") + slice + (at + TRAIL < text.length ? " …" : "");
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function distinctiveWords(description: string): string[] {
  return [...new Set(description.toLowerCase().match(/[\p{L}\d]{5,}/gu) ?? [])].slice(0, 12);
}

/**
 * HTMLRewriter hands back source text, so Steam's entities arrive undecoded. Only
 * the common ones are handled; anything rarer is noise in prose, not an error.
 */
function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function collapse(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}
