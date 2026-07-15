from pathlib import Path

import pytest
import yaml
from yaml.constructor import ConstructorError


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = REPO_ROOT / ".github" / "workflows"


class UniqueKeySafeLoader(yaml.SafeLoader):
    """Safe YAML loader that fails instead of silently overwriting duplicate keys."""


def _construct_unique_mapping(loader: UniqueKeySafeLoader, node: yaml.MappingNode, deep: bool = False):
    loader.flatten_mapping(node)
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        try:
            duplicate = key in mapping
        except TypeError as exc:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                "found an unhashable key",
                key_node.start_mark,
            ) from exc
        if duplicate:
            raise ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"found duplicate key ({key!r})",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeySafeLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    _construct_unique_mapping,
)


def _load_workflow(source: str):
    return yaml.load(source, Loader=UniqueKeySafeLoader)


def test_strict_loader_rejects_duplicate_mapping_keys():
    with pytest.raises(ConstructorError, match="found duplicate key"):
        _load_workflow("permissions:\n  contents: read\npermissions:\n  actions: read\n")


@pytest.mark.parametrize(
    "workflow_path",
    sorted((*WORKFLOW_DIR.glob("*.yml"), *WORKFLOW_DIR.glob("*.yaml"))),
    ids=lambda path: path.name,
)
def test_active_github_workflow_is_strict_yaml(workflow_path: Path):
    document = _load_workflow(workflow_path.read_text(encoding="utf-8"))
    assert isinstance(document, dict), f"{workflow_path} must contain a YAML mapping"
