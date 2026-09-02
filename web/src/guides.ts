/**
 * Steam community guides as a text corpus.
 *
 * Steam publishes guide metadata through its API but not guide bodies: the
 * `file_description` field of IPublishedFileService/GetDetails carries only the
 * author's summary, `num_children` is 0 and `file_url` points at the cover
 * image. The text a reader actually wants exists solely in the rendered page,
 * so it is read from there.
 *
 * Parsing happens through HTMLRewriter rather than string matching because the
 * Workers free plan allows 10ms of CPU per request. HTMLRewriter does its work
 * in the runtime rather than in JavaScript, and narrow selectors keep the
 * number of callbacks - the part that does cost JavaScript time - small.
 */

export interface GuideSection {
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

/** Guides longer than this are truncated: past it they are screenshot galleries. */
const MAX_SECTION_CHARS = 4000;

const FETCH_HEADERS = {
  // Steam serves a trimmed page to clients it does not recognise as browsers.
  "User-Agent": "Mozilla/5.0 (compatible; histlow-achievements/0.2)",
  "Accept-Language": "es,en;q=0.8",
};

export function guideUrl(id: string): string {
  return `${COMMUNITY}/sharedfiles/filedetails/?id=${id}`;
}

/**
 * The ids of a game's achievement guides, best rated first.
 *
 * `requiredtags[]=Achievements` and `browsefilter=toprated` were both verified
 * to change the result set rather than being decorative.
 */
export async function fetchGuideIds(appId: number, limit: number): Promise<string[]> {
  return guideIdsFrom(
    `${COMMUNITY}/app/${appId}/guides/?browsefilter=toprated&requiredtags%5B%5D=Achievements`,
    limit,
  );
}

/**
 * Guide ids for one achievement by name.
 *
 * The shared corpus is built from a game's best-rated achievement guides, which
 * for many games are route walkthroughs that never name an individual
 * achievement. Searching for the name finds the guides written about that one
 * achievement instead. `searchText` was verified to filter rather than being
 * ignored: a real name returns dozens of guides and a nonsense string returns
 * none.
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
 * One guide, flattened to titled sections of plain text.
 *
 * Images are dropped rather than described. A large share of Steam guides lean
 * on screenshots, and a section that survives as a title with no text is kept
 * out of the corpus instead of being offered as an answer.
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
    // The block is the author's name followed by their online status on its own
    // line, so the first non-empty line is the name.
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
 * The passages of a corpus that actually discuss one achievement.
 *
 * The achievement's own name is by far the strongest signal, and it survives
 * translation: Steam keeps achievement names in English even inside a Russian
 * guide, which is what makes a foreign-language corpus searchable at all.
 *
 * A section that scores nothing is dropped rather than included at low
 * confidence. Feeding unrelated prose to the model is how it starts inventing
 * steps, and a wrong answer costs a completionist more than no answer.
 */
export function findPassages(
  guides: Guide[],
  name: string,
  description: string,
  max: number,
  options: {
    /**
     * Treat a guide whose own title names the achievement as being about it
     * throughout. Such a guide explains "this achievement" for pages on end
     * without repeating its name, so demanding the name inside each section
     * would reject the one document written to answer the question.
     */
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
      // Keywords alone never qualify a passage; they only rank ones that
      // already mention the achievement by name.
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

  // At most one passage per guide until every guide has had a turn, so three
  // sections of one rambling walkthrough cannot crowd out three other authors.
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
 * HTMLRewriter hands back the source text of a node, so entities written by
 * Steam arrive undecoded. Only the five that XML defines are handled: anything
 * rarer is noise in a paragraph of prose, not a correctness problem.
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
