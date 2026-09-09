/**
 * Looks up the published Agent installer on GitHub Releases.
 *
 * The source repository is private: staff at a รพ.สต. must be able to fetch the
 * installer without being able to read the code, so the download is proxied by
 * this application instead of being a link to GitHub. The token used here is a
 * server-side secret and is never sent to the browser.
 *
 * Everything this module talks to is fixed at build time - owner, repository
 * and the shape of the asset name - so no caller can steer it at a different
 * path, a different repo, or a file that is not the installer.
 */
const OWNER = "ammedicine";
const REPO = "drug-data-center-sankamphaeng";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/** Only a Windows installer may be served, whatever else a release carries. */
const INSTALLER_PATTERN = /^SDCAgent-Setup-.*\.exe$/i;

export interface AgentRelease {
  /** git tag the release was cut from, e.g. "v1.0.1" */
  version: string;
  publishedAt: string | null;
  fileName: string;
  sizeBytes: number;
  /** GitHub's numeric asset id - the only thing the download route needs */
  assetId: number;
  notes: string | null;
  /**
   * Lowercase hex SHA-256 of the asset, as GitHub computed it when the file
   * was uploaded, or null when GitHub did not supply one.
   *
   * This is what makes unattended installation safe to allow at all: it is
   * read here, server side, from the release API - never sent by the machine
   * that wants to update, and never derived from the file being offered. An
   * Agent that cannot be given this hash is told an update exists and refuses
   * to install it by itself.
   */
  sha256: string | null;
}

interface GitHubAsset {
  id: number;
  name: string;
  size: number;
  /** "sha256:<hex>" on releases published since GitHub added asset digests */
  digest?: string | null;
}

interface GitHubRelease {
  tag_name: string;
  published_at: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

/** Accepts only a full lowercase hex SHA-256 announced as such. */
function sha256Of(asset: GitHubAsset): string | null {
  const raw = asset.digest?.trim().toLowerCase() ?? "";
  const match = /^sha256:([0-9a-f]{64})$/.exec(raw);
  return match ? match[1] : null;
}

function token(): string | null {
  return process.env.GITHUB_TOKEN?.trim() || null;
}

function headers(accept: string): HeadersInit {
  const value = token();
  return {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    ...(value ? { Authorization: `Bearer ${value}` } : {}),
  };
}

/**
 * Why there is nothing to download, when there is nothing to download.
 *
 * These are different situations for whoever is reading the page: "no release
 * has been cut" is for the person who builds the Agent, "this server has no
 * token" is for whoever deploys it. Collapsing both into an empty card sent
 * people looking for a missing file that was published all along.
 */
export type AgentReleaseLookup =
  | { status: "ok"; release: AgentRelease }
  | { status: "not-configured" }
  | { status: "none-published" }
  | { status: "unavailable"; detail: string };

/**
 * The latest published release, or the reason there is not one. A missing
 * installer is a normal state to render, not an error to throw at a page that
 * is about something else.
 */
export async function lookupLatestAgentRelease(
  /**
   * Defaults to "fresh" because the number on the page has to describe the
   * file the button hands over. Caching the page lookup for ten minutes while
   * the download resolved live meant that for ten minutes after publishing a
   * release, the card advertised the previous version and delivered the new
   * one - worse than either being briefly slow or briefly stale, because the
   * two disagreed. "cached" remains for any caller that only wants to know
   * whether a release exists at all.
   */
  freshness: "cached" | "fresh" = "fresh",
): Promise<AgentReleaseLookup> {
  if (!token()) return { status: "not-configured" };

  try {
    const response = await fetch(API, {
      headers: headers("application/vnd.github+json"),
      ...(freshness === "fresh"
        ? { cache: "no-store" as const }
        : { next: { revalidate: 600 } }),
    });
    if (response.status === 404) return { status: "none-published" };
    if (response.status === 401 || response.status === 403) {
      return { status: "unavailable", detail: "GITHUB_TOKEN ไม่มีสิทธิ์อ่าน repository นี้" };
    }
    if (!response.ok) {
      return { status: "unavailable", detail: `GitHub ตอบกลับ ${response.status}` };
    }

    const release = (await response.json()) as GitHubRelease;
    // /releases/latest already excludes drafts and prereleases, and a tag with
    // no release of its own is invisible to it - v1.1.4 exists as a tag and
    // must never be offered to anybody. Checked again rather than assumed.
    if (release.draft || release.prerelease) return { status: "none-published" };

    const asset = release.assets?.find((item) => INSTALLER_PATTERN.test(item.name));
    if (!asset) {
      return {
        status: "unavailable",
        detail: `release ${release.tag_name} ไม่มีไฟล์ชื่อ SDCAgent-Setup-*.exe แนบไว้`,
      };
    }

    return {
      status: "ok",
      release: {
        version: release.tag_name,
        publishedAt: release.published_at,
        fileName: asset.name,
        sizeBytes: asset.size,
        assetId: asset.id,
        notes: release.body?.trim() || null,
        sha256: sha256Of(asset),
      },
    };
  } catch (error) {
    return {
      status: "unavailable",
      detail: error instanceof Error ? error.message : "ติดต่อ GitHub ไม่ได้",
    };
  }
}

/** Convenience for callers that only care whether there is a file. */
export async function getLatestAgentRelease(): Promise<AgentRelease | null> {
  const lookup = await lookupLatestAgentRelease();
  return lookup.status === "ok" ? lookup.release : null;
}

/**
 * Opens the installer for streaming. Takes no caller-supplied path: it looks
 * the release up again and uses the asset id it finds, so a request can only
 * ever download the current installer.
 */
export async function openAgentInstaller(): Promise<{
  body: ReadableStream<Uint8Array>;
  fileName: string;
  sizeBytes: number;
} | null> {
  const lookup = await lookupLatestAgentRelease("fresh");
  if (lookup.status !== "ok") return null;
  const release = lookup.release;

  const response = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${release.assetId}`,
    { headers: headers("application/octet-stream"), redirect: "follow", cache: "no-store" },
  );
  if (!response.ok || !response.body) return null;

  return { body: response.body, fileName: release.fileName, sizeBytes: release.sizeBytes };
}
