import importlib.metadata
import re
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
NAME_PATTERN = r"[A-Za-z0-9][A-Za-z0-9_.-]*"
LOCK_ENTRY = re.compile(rf"^({NAME_PATTERN})==([0-9]+(?:\.[0-9]+)*)\s+\\$")
HASH_ENTRY = re.compile(r"^\s+--hash=sha256:([a-f0-9]{64})(?:\s+\\)?$")
REQUIREMENT = re.compile(rf"^({NAME_PATTERN})((?:(?:==|!=|>=|<=|>|<)[0-9]+(?:\.[0-9]+)*(?:,|$))*)$")
CLAUSE = re.compile(r"(==|!=|>=|<=|>|<)([0-9]+(?:\.[0-9]+)*)")


def canonical_name(value):
    return re.sub(r"[-_.]+", "-", value).lower()


def parse_version(value):
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]+)*", value):
        raise ValueError(f"unsupported non-numeric dependency version: {value}")
    return tuple(int(part) for part in value.split("."))


def compare_versions(left, right):
    width = max(len(left), len(right))
    return (left + (0,) * (width - len(left))) < (right + (0,) * (width - len(right)))


def version_satisfies(version, clauses):
    actual = parse_version(version)
    for operator, expected_text in clauses:
        expected = parse_version(expected_text)
        less = compare_versions(actual, expected)
        greater = compare_versions(expected, actual)
        equal = not less and not greater
        if operator == "==" and not equal:
            return False
        if operator == "!=" and equal:
            return False
        if operator == ">=" and less:
            return False
        if operator == "<=" and greater:
            return False
        if operator == ">" and not greater:
            return False
        if operator == "<" and not less:
            return False
    return True


def parse_requirement(value):
    compact = re.sub(r"\s+", "", value)
    match = REQUIREMENT.fullmatch(compact)
    if not match:
        raise ValueError(f"unsupported dependency requirement: {value}")
    name, suffix = match.groups()
    clauses = CLAUSE.findall(suffix)
    if suffix and not clauses:
        raise ValueError(f"dependency has no parseable version clauses: {value}")
    return canonical_name(name), clauses


def parse_lock(text):
    locked = {}
    hashes = {}
    current = None
    for line_number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        package = LOCK_ENTRY.fullmatch(line)
        if package:
            if current is not None and not hashes[current]:
                raise ValueError(f"locked package {current} has no SHA-256 artifacts")
            name, version = package.groups()
            current = canonical_name(name)
            if current in locked:
                raise ValueError(f"duplicate locked package: {current}")
            locked[current] = version
            hashes[current] = set()
            continue
        digest = HASH_ENTRY.fullmatch(line)
        if digest and current is not None:
            if digest.group(1) in hashes[current]:
                raise ValueError(f"duplicate artifact hash for {current}")
            hashes[current].add(digest.group(1))
            continue
        raise ValueError(f"unsupported requirements-lock line {line_number}: {line}")
    if current is not None and not hashes[current]:
        raise ValueError(f"locked package {current} has no SHA-256 artifacts")
    if not locked:
        raise ValueError("requirements-lock.txt contains no packages")
    return locked, hashes


class DependencyLockTests(unittest.TestCase):
    def test_runtime_dependencies_have_no_legacy_requirements_manifest(self):
        self.assertFalse(
            (ROOT / "requirements.txt").exists(),
            "declare runtime dependencies only in pyproject.toml and install requirements-lock.txt",
        )

    def test_audit_tooling_has_an_independent_hashed_lock(self):
        runtime, _ = parse_lock((ROOT / "requirements-lock.txt").read_text(encoding="utf-8"))
        audit, hashes = parse_lock((ROOT / "requirements-audit-lock.txt").read_text(encoding="utf-8"))
        audit_input = (ROOT / "requirements-audit.in").read_text(encoding="utf-8")
        self.assertEqual(audit["pip-audit"], "2.10.1")
        self.assertRegex(audit_input, r"(?m)^pip-audit==2\.10\.1$")
        self.assertNotIn("pip-audit", runtime)
        self.assertTrue(all(hashes.values()))

    def test_pyproject_ranges_and_installed_runtime_closure_match_hashed_lock(self):
        project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
        locked, hashes = parse_lock((ROOT / "requirements-lock.txt").read_text(encoding="utf-8"))
        direct = {}
        for requirement in project["project"]["dependencies"]:
            name, clauses = parse_requirement(requirement)
            self.assertIn(name, locked, f"direct dependency {name} is absent from requirements-lock.txt")
            self.assertTrue(version_satisfies(locked[name], clauses), f"locked {name} violates pyproject.toml")
            direct[name] = clauses

        reachable = set(direct)
        pending = list(direct)
        while pending:
            package = pending.pop()
            self.assertEqual(importlib.metadata.version(package), locked[package])
            for raw_requirement in importlib.metadata.requires(package) or []:
                requirement, separator, marker = raw_requirement.partition(";")
                if separator:
                    if "extra ==" in marker or "extra==" in marker:
                        continue
                    self.fail(f"unsupported environment-marked runtime dependency: {raw_requirement}")
                dependency, clauses = parse_requirement(requirement)
                self.assertIn(dependency, locked, f"runtime dependency {dependency} is absent from the lock")
                self.assertTrue(
                    version_satisfies(locked[dependency], clauses),
                    f"locked {dependency} violates {package} metadata",
                )
                if dependency not in reachable:
                    reachable.add(dependency)
                    pending.append(dependency)

        self.assertEqual(set(locked), reachable, "requirements-lock.txt contains undeclared runtime packages")
        self.assertTrue(all(hashes.values()))

    def test_lock_parser_fails_closed_on_missing_or_duplicate_hashes(self):
        with self.assertRaisesRegex(ValueError, "no SHA-256 artifacts"):
            parse_lock("requests==2.33.1 \\")
        digest = "a" * 64
        with self.assertRaisesRegex(ValueError, "duplicate artifact hash"):
            parse_lock(
                f"requests==2.33.1 \\\n"
                f"    --hash=sha256:{digest} \\\n"
                f"    --hash=sha256:{digest}"
            )


if __name__ == "__main__":
    unittest.main()
