export interface StepRecord {
  id: number;
  entity: string;
  args: string[];
  raw: string;
}

export interface StepModel {
  header: string;
  records: Map<number, StepRecord>;
  footer: string;
}

export function nextStepId(records: ReadonlyMap<number, unknown>): number {
  let maximum = 0;
  for (const id of records.keys()) {
    if (id > maximum) maximum = id;
  }
  return maximum + 1;
}

export function splitStepArgs(input: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === "'") {
      if (inString && input[i + 1] === "'") {
        i += 1;
      } else {
        inString = !inString;
      }
    } else if (!inString) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        args.push(input.slice(start, i).trim());
        start = i + 1;
      }
    }
  }

  args.push(input.slice(start).trim());
  return args;
}

// Direct charCode comparisons instead of per-character regex tests (/\s/.test(), /\d/.test(), ...).
// parseStep's main loop runs once per character of the whole file, so for large (100MB+) IFC
// files this is the single hottest path in the app -- swapping regex objects for numeric range
// checks is a straightforward, behavior-preserving speedup here.
function isWhitespaceCode(code: number): boolean {
  // space, tab, LF, VT, FF, CR -- the whitespace STEP/IFC files actually contain.
  return code === 32 || (code >= 9 && code <= 13);
}
function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}
function isIdentCode(code: number): boolean {
  return isDigitCode(code) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

export function parseStep(text: string): StepModel {
  const records = new Map<number, StepRecord>();
  const firstRecord = text.search(/#\d+\s*=/);
  const header = firstRecord >= 0 ? text.slice(0, firstRecord) : text;
  let footer = "";
  let i = firstRecord >= 0 ? firstRecord : text.length;

  while (i < text.length) {
    while (i < text.length && isWhitespaceCode(text.charCodeAt(i))) i += 1;
    if (text[i] !== "#") {
      footer = text.slice(i);
      break;
    }
    const recordStart = i;
    i += 1;
    let idText = "";
    while (isDigitCode(text.charCodeAt(i))) {
      idText += text[i];
      i += 1;
    }
    while (isWhitespaceCode(text.charCodeAt(i))) i += 1;
    if (text[i] !== "=") throw new Error(`Malformed STEP record #${idText}`);
    i += 1;
    while (isWhitespaceCode(text.charCodeAt(i))) i += 1;
    let entity = "";
    while (isIdentCode(text.charCodeAt(i))) {
      entity += text[i].toUpperCase();
      i += 1;
    }
    while (isWhitespaceCode(text.charCodeAt(i))) i += 1;
    if (text[i] !== "(") throw new Error(`Malformed STEP arguments for #${idText}`);
    const argsStart = i + 1;
    let depth = 1;
    let inString = false;
    i += 1;
    while (i < text.length && depth > 0) {
      const char = text[i];
      if (char === "'") {
        if (inString && text[i + 1] === "'") {
          i += 1;
        } else {
          inString = !inString;
        }
      } else if (!inString) {
        if (char === "(") depth += 1;
        if (char === ")") depth -= 1;
      }
      i += 1;
    }
    if (depth !== 0) throw new Error(`Unclosed STEP arguments for #${idText}`);
    const argsText = text.slice(argsStart, i - 1);
    while (isWhitespaceCode(text.charCodeAt(i))) i += 1;
    if (text[i] !== ";") throw new Error(`Missing semicolon for #${idText}`);
    i += 1;
    const raw = text.slice(recordStart, i);
    records.set(Number(idText), { id: Number(idText), entity, args: splitStepArgs(argsText), raw });
  }

  return { header, records, footer };
}

export function serializeRecord(record: StepRecord): string {
  return `#${record.id}= ${record.entity}(${record.args.join(",")});`;
}

export function serializeStep(model: StepModel, deleted = new Set<number>()): string {
  const records = [...model.records.values()];
  let sorted = true;
  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1].id > records[index].id) {
      sorted = false;
      break;
    }
  }
  if (!sorted) records.sort((a, b) => a.id - b.id);

  const lines: string[] = [];
  for (const record of records) {
    if (!deleted.has(record.id)) lines.push(serializeRecord(record));
  }
  return `${model.header}${lines.join("\n")}\n${model.footer.trimStart()}`;
}

export function unquoteStep(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) return trimmed === "$" ? "" : trimmed;
  return trimmed.slice(1, -1).replace(/''/g, "'");
}

export function quoteStep(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function parseRef(value: string): number | undefined {
  const match = value.trim().match(/^#(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

export function parseRefList(value: string): number[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) return [];
  return splitStepArgs(trimmed.slice(1, -1)).map(parseRef).filter((id): id is number => typeof id === "number");
}

export function formatRefList(ids: number[]): string {
  return `(${ids.map((id) => `#${id}`).join(",")})`;
}

export function parseEnum(value: string): string {
  const match = value.trim().match(/^\.(.*)\.$/);
  return match ? match[1] : "";
}

export function parseTypedValue(value: string): { type: string; value: string; empty: boolean; numeric?: number } {
  const trimmed = value.trim();
  if (trimmed === "$") return { type: "$", value: "$", empty: true };
  const match = trimmed.match(/^([A-Z0-9_]+)\((.*)\)$/i);
  if (!match) return { type: "", value: trimmed, empty: trimmed.length === 0 };
  const type = match[1].toUpperCase();
  const rawValue = match[2].trim();
  const display = rawValue.startsWith("'") ? unquoteStep(rawValue) : rawValue;
  const numeric = Number(display.replace(/^\./, "").replace(/\.$/, ""));
  return { type, value: display, empty: display.trim().length === 0, numeric: Number.isFinite(numeric) ? numeric : undefined };
}

export function collectReferences(args: string[]): number[] {
  // Quote-aware: a "#123"-looking token inside a quoted text value (e.g. a name like
  // 'Unit #12') is text, not an entity reference, and must not be counted -- otherwise
  // dangling-reference validation can report false positives for perfectly valid files.
  const refs: number[] = [];
  for (const arg of args) {
    let inString = false;
    for (let i = 0; i < arg.length; i += 1) {
      const char = arg[i];
      if (char === "'") {
        if (inString && arg[i + 1] === "'") {
          i += 1;
        } else {
          inString = !inString;
        }
        continue;
      }
      if (!inString && char === "#") {
        let j = i + 1;
        let digits = "";
        while (j < arg.length && isDigitCode(arg.charCodeAt(j))) {
          digits += arg[j];
          j += 1;
        }
        if (digits) {
          refs.push(Number(digits));
          i = j - 1;
        }
      }
    }
  }
  return refs;
}
