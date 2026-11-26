"""Validate an export workbook with openpyxl (an independent reader). Prints a JSON summary, never cell text.

    python -I tools/local/scripts/validate_xlsx.py <file.xlsx>
"""
import json
import sys

import openpyxl

wb = openpyxl.load_workbook(sys.argv[1])  # raises if the package or XML is invalid
out = {"sheets": [], "ok": True}
for ws in wb.worksheets:
    rows = list(ws.iter_rows(values_only=False))
    header = [c.value for c in rows[0]] if rows else []
    formulas = []
    for r in rows[1:]:
        for c in r:
            if isinstance(c.value, str) and c.value.startswith("="):
                formulas.append(header[c.column - 1] if c.column - 1 < len(header) else c.column)
    out["sheets"].append(
        {
            "name": ws.title,
            "rows": max(0, len(rows) - 1),
            "header": header if ws.title != "Summary" else header[:2],
            "formulaColumns": sorted(set(str(f) for f in formulas)),
        }
    )
    # Only our own HYPERLINK cells may be formulas, and only in URL columns.
    bad = [f for f in formulas if str(f) not in ("url", "profile_url", "thumbnail_url")]
    if bad:
        out["ok"] = False
        out.setdefault("unexpectedFormulas", []).extend(str(b) for b in bad)
print(json.dumps(out))
