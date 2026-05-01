#!/usr/bin/env python3
"""Parse the RouteReady Automation workbook (markdown export) into per-tab data."""
import json
import re
import sys
from pathlib import Path

WORKBOOK = "/root/.claude/projects/-home-user-routeready/1ae908e7-99ea-4b35-b37f-68cdc3e3233a/tool-results/mcp-Google_Drive-read_file_content-1777593201824.txt"


_MD_SPECIAL = re.compile(r"\\([|_*\[\]()!#.<>{}`+\-=])")


def unescape_md(s: str) -> str:
    if s is None:
        return s
    s = s.replace("\\\\", "\x00")
    s = _MD_SPECIAL.sub(r"\1", s)
    s = s.replace("\x00", "\\")
    return s.strip()


_PIPE_SPLIT = re.compile(r"(?<!\\)\|")


def split_pipes(line: str):
    """Split on `|` but not on escaped `\\|`."""
    line = line.strip()
    if line.startswith("|"):
        line = line[1:]
    if line.endswith("|"):
        line = line[:-1]
    return _PIPE_SPLIT.split(line)


def parse_md_table(block: str):
    lines = [ln for ln in block.split("\n") if ln.strip()]
    if len(lines) < 2:
        return None, []
    header_cells = [unescape_md(c) for c in split_pipes(lines[0])]
    sep = lines[1]
    if not re.match(r"^\s*\|?\s*:?-+:?\s*\|", sep):
        return None, []
    rows = []
    for ln in lines[2:]:
        cells = [unescape_md(c) for c in split_pipes(ln)]
        if len(cells) < len(header_cells):
            cells += [""] * (len(header_cells) - len(cells))
        elif len(cells) > len(header_cells):
            cells = cells[: len(header_cells) - 1] + [
                " | ".join(cells[len(header_cells) - 1:])
            ]
        rows.append(dict(zip(header_cells, cells)))
    return header_cells, rows


def main():
    raw = json.loads(Path(WORKBOOK).read_text())["fileContent"]
    blocks = raw.split("\n\n")
    parsed = []
    for i, b in enumerate(blocks):
        if not b.strip():
            continue
        header, rows = parse_md_table(b)
        if header is None:
            continue
        parsed.append({"block": i, "header": header, "rows": rows})

    print(f"Parsed {len(parsed)} tables")
    for p in parsed:
        print(f"  block {p['block']}: cols={len(p['header'])} data_rows={len(p['rows'])} | {p['header'][:6]}{'...' if len(p['header'])>6 else ''}")

    out = Path("/home/user/routeready/migration/parsed.json")
    out.write_text(json.dumps(parsed, indent=2))
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
