/**
 * PROTOTYPE — three GitHub contribution-card variants on the existing dashboard.
 * Rewrite the selected variant as production code after the design is validated.
 */

export interface GitHubContributionDay {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
  weekday: number;
}

export interface GitHubContributionWeek {
  firstDay: string;
  days: GitHubContributionDay[];
}

export interface GitHubContributionMonth {
  firstDay: string;
  name: string;
  totalWeeks: number;
  year: number;
}

export interface GitHubContributions {
  status: "ok";
  login: string;
  name?: string;
  profileUrl: string;
  startedAt: string;
  endedAt: string;
  total: number;
  activeDays: number;
  longestStreak: number;
  currentStreak: number;
  busiestDay?: GitHubContributionDay;
  breakdown: {
    commits: number;
    pullRequests: number;
    reviews: number;
    issues: number;
    restricted: number;
  };
  months: GitHubContributionMonth[];
  weeks: GitHubContributionWeek[];
  source: "GitHub CLI · GraphQL";
  generatedAt: string;
}

export interface GitHubContributionsUnavailable {
  status: "unavailable";
  message: string;
  generatedAt: string;
}

export type GitHubContributionsResult = GitHubContributions | GitHubContributionsUnavailable;

const QUERY = `
query LlmQuotaContributionCalendar {
  viewer {
    login
    name
    url
    contributionsCollection {
      startedAt
      endedAt
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        months { firstDay name totalWeeks year }
        weeks {
          firstDay
          contributionDays { date contributionCount contributionLevel weekday }
        }
      }
    }
  }
}
`;

const LEVELS: Record<string, GitHubContributionDay["level"]> = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

let cache: { expiresAt: number; value: GitHubContributionsResult } | undefined;
let inFlight: Promise<GitHubContributionsResult> | undefined;

function streaks(days: GitHubContributionDay[]): { longest: number; current: number } {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }

  let index = days.length - 1;
  const today = new Date().toISOString().slice(0, 10);
  if (days[index]?.date === today && days[index]?.count === 0) index -= 1;
  let current = 0;
  while (index >= 0 && days[index]!.count > 0) {
    current += 1;
    index -= 1;
  }
  return { longest, current };
}

async function queryGitHub(): Promise<GitHubContributionsResult> {
  try {
    const child = Bun.spawn(["gh", "api", "graphql", "-f", `query=${QUERY}`], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error("gh_failed");

    const response = JSON.parse(stdout);
    const viewer = response?.data?.viewer;
    const collection = viewer?.contributionsCollection;
    const calendar = collection?.contributionCalendar;
    if (!viewer?.login || !calendar?.weeks) throw new Error("invalid_github_response");

    const weeks: GitHubContributionWeek[] = calendar.weeks.map((week: any) => ({
      firstDay: String(week.firstDay),
      days: (week.contributionDays ?? []).map((day: any) => ({
        date: String(day.date),
        count: Math.max(0, Number(day.contributionCount) || 0),
        level: LEVELS[String(day.contributionLevel)] ?? 0,
        weekday: Math.max(0, Math.min(6, Number(day.weekday) || 0)),
      })),
    }));
    const days = weeks.flatMap((week) => week.days).sort((a, b) => a.date.localeCompare(b.date));
    const activity = streaks(days);
    const busiestDay = days.reduce<GitHubContributionDay | undefined>(
      (busiest, day) => !busiest || day.count > busiest.count ? day : busiest,
      undefined,
    );

    return {
      status: "ok",
      login: viewer.login,
      ...(viewer.name ? { name: String(viewer.name) } : {}),
      profileUrl: String(viewer.url),
      startedAt: String(collection.startedAt),
      endedAt: String(collection.endedAt),
      total: Math.max(0, Number(calendar.totalContributions) || 0),
      activeDays: days.filter((day) => day.count > 0).length,
      longestStreak: activity.longest,
      currentStreak: activity.current,
      ...(busiestDay?.count ? { busiestDay } : {}),
      breakdown: {
        commits: Math.max(0, Number(collection.totalCommitContributions) || 0),
        pullRequests: Math.max(0, Number(collection.totalPullRequestContributions) || 0),
        reviews: Math.max(0, Number(collection.totalPullRequestReviewContributions) || 0),
        issues: Math.max(0, Number(collection.totalIssueContributions) || 0),
        restricted: Math.max(0, Number(collection.restrictedContributionsCount) || 0),
      },
      months: (calendar.months ?? []).map((month: any) => ({
        firstDay: String(month.firstDay),
        name: String(month.name),
        totalWeeks: Math.max(0, Number(month.totalWeeks) || 0),
        year: Number(month.year),
      })),
      weeks,
      source: "GitHub CLI · GraphQL",
      generatedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: "unavailable",
      message: "GitHub activity needs the official GitHub CLI. Install gh and run `gh auth login`.",
      generatedAt: new Date().toISOString(),
    };
  }
}

export async function collectGitHubContributions(): Promise<GitHubContributionsResult> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  inFlight ??= queryGitHub().then((value) => {
    cache = { value, expiresAt: Date.now() + 10 * 60_000 };
    return value;
  }).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
