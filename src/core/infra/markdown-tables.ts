function parseTableCells(line: string): string[] {
  let content = line.trim();
  if (content.startsWith("|")) content = content.slice(1);
  if (content.endsWith("|")) content = content.slice(0, -1);
  return content.split("|").map((cell) => cell.trim());
}

function isDashFragment(line: string): boolean {
  return /^-+$/.test(line.trim());
}

function isSeparatorCells(cells: string[]): boolean {
  return (
    cells.length > 0 &&
    cells.every((cell) => {
      const cleaned = cell.replace(/:/g, "").trim();
      return /^-+$/.test(cleaned) || cleaned === "";
    })
  );
}

function formatTableRow(cells: string[], colCount: number): string {
  const normalized = [...cells];
  while (normalized.length < colCount) normalized.push("");
  if (normalized.length > colCount) normalized.length = colCount;
  return `| ${normalized.join(" | ")} |`;
}

function splitTrailingTableOverflow(cell: string): { cell: string; overflow?: string } {
  const match = cell.match(
    /^([\s\S]*?)(?=(?:\*\*(?:Dependencies|Total|No blocking)|(?:Dependencies|Total|No blocking questions):|### Step \d|## [A-Z]))/
  );
  if (!match?.[1]) return { cell };
  const trimmed = match[1].trimEnd();
  const overflow = cell.slice(trimmed.length).trim();
  return overflow ? { cell: trimmed, overflow } : { cell };
}

function repairStreamedTableBlock(pipeLines: string[]): { rows: string[]; overflow?: string } {
  if (!pipeLines.length) return { rows: [] };

  const headerLine = pipeLines[0];
  if (!headerLine) return { rows: [] };

  let headerCells = parseTableCells(headerLine);
  const trailingHeaderCell = headerCells[headerCells.length - 1];
  if (headerCells.length > 1 && trailingHeaderCell && isSeparatorCells([trailingHeaderCell])) {
    headerCells = headerCells.slice(0, -1);
  }
  const colCount = Math.max(1, headerCells.length);

  const bodyCells: string[] = [];
  for (let i = 1; i < pipeLines.length; i++) {
    const pipeLine = pipeLines[i];
    if (!pipeLine) continue;
    const cells = parseTableCells(pipeLine);
    if (!cells.length || isSeparatorCells(cells)) continue;
    bodyCells.push(...cells);
  }

  let overflow: string | undefined;
  if (bodyCells.length) {
    const lastIndex = bodyCells.length - 1;
    const lastCell = bodyCells[lastIndex];
    if (lastCell) {
      const split = splitTrailingTableOverflow(lastCell);
      bodyCells[lastIndex] = split.cell;
      overflow = split.overflow;
    }
  }

  const rows = [
    formatTableRow(headerCells, colCount),
    formatTableRow(Array.from({ length: colCount }, () => "---"), colCount)
  ];
  for (let i = 0; i < bodyCells.length; i += colCount) {
    rows.push(formatTableRow(bodyCells.slice(i, i + colCount), colCount));
  }
  return { rows, ...(overflow !== undefined ? { overflow } : {}) };
}

function isTableRegionLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.includes("|")) return true;
  if (trimmed === "") return true;
  if (isDashFragment(line)) return true;
  return false;
}

function collectTableRegion(
  lines: string[],
  start: number
): { pipeLines: string[]; next: number } {
  const pipeLines: string[] = [];
  let index = start;

  while (index < lines.length && isTableRegionLine(lines[index] ?? "")) {
    const line = lines[index];
    if (!line) {
      index++;
      continue;
    }
    if (line.includes("|")) {
      pipeLines.push(line);
    }
    index++;
  }

  return { pipeLines, next: index };
}

/** Rebuild streamed tables using header column counts. */
export function repairStreamedTables(text: string): string {
  if (!text.includes("|")) return text;

  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line || !line.includes("|")) {
      if (line) output.push(line);
      index++;
      continue;
    }

    const { pipeLines, next } = collectTableRegion(lines, index);
    index = next;

    if (!pipeLines.length) {
      output.push(line);
      index++;
      continue;
    }

    const previousLine = output[output.length - 1];
    if (output.length && previousLine?.trim() && !previousLine.includes("|")) {
      output.push("");
    }

    const { rows, overflow } = repairStreamedTableBlock(pipeLines);
    output.push(...rows);
    if (overflow) {
      output.push("");
      output.push(overflow);
    }
  }

  return output.join("\n");
}