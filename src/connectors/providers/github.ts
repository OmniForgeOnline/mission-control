import { bindIssueTask, indexLocalRepos } from "../repo-bind.ts";
import type { ConnectorResourceOption, CreateTaskInput } from "../../core/types.ts";

type FetchLike = typeof fetch;

interface GithubUser {
  login?: string;
}

interface GithubRepo {
  full_name: string;
  owner: { login: string };
  name: string;
}

interface GithubIssue {
  number: number;
  title: string;
  html_url: string;
}

async function listGithubRepos(token: string, fetchImpl: FetchLike): Promise<GithubRepo[]> {
  const repos: GithubRepo[] = [];
  let page = 1;
  while (page <= 5) {
    const response = await fetchImpl(`https://api.github.com/user/repos?per_page=100&page=${page}&sort=updated`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json"
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub repo lookup failed with status ${response.status}`);
    }
    const batch = (await response.json()) as GithubRepo[];
    repos.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return repos;
}

export async function fetchGithubAccount(
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<{ accountLabel: string }> {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json"
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub account lookup failed with status ${response.status}`);
  }
  const user = (await response.json()) as GithubUser;
  return { accountLabel: user.login ?? "GitHub user" };
}

export async function fetchGithubResources(
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<ConnectorResourceOption[]> {
  const repos = await listGithubRepos(token, fetchImpl);
  return repos.map((repo) => ({
    id: repo.full_name,
    label: repo.full_name,
    meta: {
      owner: repo.owner.login,
      repo: repo.name,
      slug: repo.full_name
    }
  }));
}

export async function importGithubIssues(options: {
  token?: string;
  projectsRoot: string;
  fetchImpl?: FetchLike;
  perRepoLimit?: number;
  totalLimit?: number;
}): Promise<CreateTaskInput[]> {
  if (!options.token) {
    return [];
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const perRepoLimit = options.perRepoLimit ?? 10;
  const totalLimit = options.totalLimit ?? 50;
  const [repos, repoIndex] = await Promise.all([
    listGithubRepos(options.token, fetchImpl),
    indexLocalRepos(options.projectsRoot)
  ]);

  const tasks: CreateTaskInput[] = [];
  for (const repo of repos) {
    if (tasks.length >= totalLimit) break;
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo.full_name}/issues?state=open&per_page=${perRepoLimit}`,
      {
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: "application/vnd.github+json"
        }
      }
    );
    if (!response.ok) {
      continue;
    }
    const issues = (await response.json()) as GithubIssue[];
    for (const issue of issues) {
      if (tasks.length >= totalLimit) break;
      const bound = bindIssueTask({
        title: `GitHub ${repo.full_name} #${issue.number}: ${issue.title}`,
        issueUrl: issue.html_url,
        source: "github",
        host: "github.com",
        slug: repo.full_name,
        projectsRoot: options.projectsRoot,
        repoIndex
      });
      tasks.push({
        title: `GitHub ${repo.full_name} #${issue.number}: ${issue.title}`,
        description: bound.description,
        agent: "claude",
        source: "github",
        links: [{ label: `#${issue.number}`, url: issue.html_url }],
        targets: bound.targets
      });
    }
  }
  return tasks;
}