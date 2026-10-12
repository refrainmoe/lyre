type JsonContainerFrame =
  | {
      kind: "object";
      state: "key_or_end" | "colon" | "value" | "comma_or_end";
      keys: Set<string>;
    }
  | { kind: "array"; state: "value_or_end" | "comma_or_end" };

/**
 * Dependency-free JSON admission for the testbed and its Vite config.
 *
 * Keeping this primitive local is intentional: Vite loads its config through
 * Node before it can resolve the workspace's TypeScript development exports.
 * The parser still enforces Lyre's duplicate-member rejection instead of
 * falling back to JSON.parse's last-member-wins behavior.
 */
export function parseTestbedJson(text: string, label = "JSON document"): unknown {
  const value: unknown = JSON.parse(text);
  assertUniqueObjectMembers(text, label);
  return value;
}

function assertUniqueObjectMembers(text: string, label: string): void {
  let offset = 0;
  const stack: JsonContainerFrame[] = [];

  const skipWhitespace = (): void => {
    while (offset < text.length) {
      const ch = text[offset];
      if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") return;
      offset++;
    }
  };

  const readString = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const ch = text[offset++];
      if (ch === "\\") offset++;
      else if (ch === '"') break;
    }
    return JSON.parse(text.slice(start, offset)) as string;
  };

  const beginValue = (): void => {
    skipWhitespace();
    const ch = text[offset];
    if (ch === '"') {
      readString();
      return;
    }
    if (ch === "{") {
      offset++;
      stack.push({ kind: "object", state: "key_or_end", keys: new Set() });
      return;
    }
    if (ch === "[") {
      offset++;
      stack.push({ kind: "array", state: "value_or_end" });
      return;
    }
    while (offset < text.length) {
      const token = text[offset];
      if (
        token === " " ||
        token === "\n" ||
        token === "\r" ||
        token === "\t" ||
        token === "," ||
        token === "]" ||
        token === "}"
      ) {
        return;
      }
      offset++;
    }
  };

  beginValue();
  while (stack.length > 0) {
    skipWhitespace();
    const frame = stack[stack.length - 1]!;
    if (frame.kind === "object") {
      if (frame.state === "key_or_end") {
        if (text[offset] === "}") {
          offset++;
          stack.pop();
          continue;
        }
        const key = readString();
        if (frame.keys.has(key)) {
          const abbreviated = key.length > 128 ? `${key.slice(0, 128)}…` : key;
          throw new SyntaxError(
            `${label} contains duplicate JSON object member ${JSON.stringify(abbreviated)}`,
          );
        }
        frame.keys.add(key);
        frame.state = "colon";
      } else if (frame.state === "colon") {
        offset++; // ':'; the initial JSON.parse already validated the grammar.
        frame.state = "value";
      } else if (frame.state === "value") {
        frame.state = "comma_or_end";
        beginValue();
      } else if (text[offset] === ",") {
        offset++;
        frame.state = "key_or_end";
      } else {
        offset++; // '}'
        stack.pop();
      }
      continue;
    }

    if (frame.state === "value_or_end") {
      if (text[offset] === "]") {
        offset++;
        stack.pop();
      } else {
        frame.state = "comma_or_end";
        beginValue();
      }
    } else if (text[offset] === ",") {
      offset++;
      frame.state = "value_or_end";
    } else {
      offset++; // ']'
      stack.pop();
    }
  }
}
