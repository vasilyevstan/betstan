#!/usr/bin/env python3
import pathlib
import re
import sys


INPUT_EXPRESSION = re.compile(
    r"\$\{\{\s*(?:github\.event\.)?inputs\."
)


def workflow_files(paths: list[str]) -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for raw_path in paths:
        path = pathlib.Path(raw_path)
        if path.is_dir():
            files.extend(path.glob("*.yml"))
            files.extend(path.glob("*.yaml"))
        elif path.is_file():
            files.append(path)
        else:
            raise ValueError(f"workflow path does not exist: {path}")

    return sorted(set(files))


def direct_shell_interpolations(path: pathlib.Path) -> list[str]:
    violations: list[str] = []
    run_indent: int | None = None

    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        stripped = line.strip()
        indent = len(line) - len(line.lstrip(" "))

        if run_indent is not None:
            if stripped and indent <= run_indent:
                run_indent = None
            elif INPUT_EXPRESSION.search(line):
                violations.append(f"{path}:{line_number}")

        match = re.match(r"^( *)(?:-\s*)?run\s*:\s*(.*)$", line)
        if match:
            if INPUT_EXPRESSION.search(match.group(2)):
                violations.append(f"{path}:{line_number}")
            run_indent = len(match.group(1))

    return violations


def main() -> int:
    targets = sys.argv[1:] or [".github/workflows"]
    try:
        files = workflow_files(targets)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2

    if not files:
        print("no workflow files found", file=sys.stderr)
        return 2

    violations = [
        violation
        for path in files
        for violation in direct_shell_interpolations(path)
    ]
    if violations:
        print(
            "Direct inputs interpolation in workflow shell step: "
            + ", ".join(violations),
            file=sys.stderr,
        )
        return 1

    print(f"workflow_shell_input_guard=PASS workflows={len(files)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
