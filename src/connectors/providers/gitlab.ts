import { bindIssueTask, indexLocalRepos } from "../repo-bind.ts";
import type { ConnectorResourceOption, CreateTaskInput } from "../../core/types.ts";

type FetchLike = typeof fetch;

interface GitlabUser {
  username?: string;
  name?: string;
}

interface GitlabProject {
  id: number;
  path_with_namespace: string;
}

interface GitlabIssue {
  iid: number;
  title: string;
  web_url: string;
}

async function listGitlabProjects(token: string, fetchImpl: FetchLike): Promise<GitlabProject[]> {
  const projects: GitlabProject[] = [];
  let page = 1;
  while (page <= 5) {
    const response = await fetchImpl(
      `https://gitlab.com/api/v4/projects?membership=true&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) {
      throw new Error(`GitLab project lookup failed with status ${response.status}`);
    }
    const batch = (await response.json()) as GitlabProject[];
    projects.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return projects;
}

export async function fetchGitlabAccount(
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<{ accountLabel: string }> {
  const response = await fetchImpl("https://gitlab.com/api/v4/user", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`GitLab account lookup failed with status ${response.status}`);
  }
  const user = (await response.json()) as GitlabUser;
  return { accountLabel: user.username ?? user.name ?? "GitLab user" };
}

export async function fetchGitlabResources(
  token: string,
  fetchImpl: FetchLike = fetch
): Promise<ConnectorResourceOption[]> {
  const projects = await listGitlabProjects(token, fetchImpl);
  return projects.map((project) => ({
    id: String(project.id),
    label: project.path_with_namespace,
    meta: { projectId: String(project.id), slug: project.path_with_namespace }
  }));
}

export async function importGitlabIssues(options: {
  token?: string;
  projectsRoot: string;
  fetchImpl?: FetchLike;
  perProjectLimit?: number;
  totalLimit?: number;
}): Promise<CreateTaskInput[]> {
  if (!options.token) {
    return [];
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const perProjectLimit = options.perProjectLimit ?? 10;
  const totalLimit = options.totalLimit ?? 50;
  const [projects, repoIndex] = await Promise.all([
    listGitlabProjects(options.token, fetchImpl),
    indexLocalRepos(options.projectsRoot)
  ]);

  const tasks: CreateTaskInput[] = [];
  for (const project of projects) {
    if (tasks.length >= totalLimit) break;
    const response = await fetchImpl(
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(String(project.id))}/issues?state=opened&per_page=${perProjectLimit}`,
      { headers: { Authorization: `Bearer ${options.token}` } }
    );
    if (!response.ok) {
      continue;
    }
    const issues = (await response.json()) as GitlabIssue[];
    for (const issue of issues) {
      if (tasks.length >= totalLimit) break;
      const bound = bindIssueTask({
        title: `GitLab ${project.path_with_namespace} #${issue.iid}: ${issue.title}`,
        issueUrl: issue.web_url,
        source: "gitlab",
        host: "gitlab.com",
        slug: project.path_with_namespace,
        projectsRoot: options.projectsRoot,
        repoIndex
      });
      tasks.push({
        title: `GitLab ${project.path_with_namespace} #${issue.iid}: ${issue.title}`,
        description: bound.description,
        agent: "claude",
        source: "gitlab",
        links: [{ label: `#${issue.iid}`, url: issue.web_url }],
        targets: bound.targets
      });
    }
  }
  return tasks;
}