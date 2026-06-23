// Git hooks export GIT_* variables; inherited env breaks temp-repo git commands in tests.
for (const key of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"] as const) {
  delete process.env[key];
}
