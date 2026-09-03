"""Fail-closed validation for untrusted creative-provider JSON outputs."""

from typing import TypeVar

from pydantic import BaseModel, ValidationError


CreativeOutputModel = TypeVar("CreativeOutputModel", bound=BaseModel)


class CreativeOutputContractError(ValueError):
    """Categorical provider-shape failure that never retains raw model output."""


def localized_contract_warning(language: str, output_name: str) -> str:
    """Return categorical degraded copy without retaining provider-authored bytes."""
    locale = (language or "en-US").strip().lower()
    messages = {
        "titles": {
            "en": "Provider output did not match the contract; no titles were emitted.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; não foram emitidos títulos.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; não foram emitidos títulos.",
        },
        "thumbnail concepts": {
            "en": "Provider output did not match the contract; no thumbnail concepts were emitted.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; não foram emitidos conceitos de miniatura.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; não foram emitidos conceitos de miniatura.",
        },
        "caption": {
            "en": "Provider output did not match the contract; no caption was emitted.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; não foi emitida uma legenda.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; não foi emitida uma legenda.",
        },
        "repurposed outputs": {
            "en": "Provider output did not match the contract; no repurposed outputs were emitted.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; não foram emitidos conteúdos adaptados.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; não foram emitidos conteúdos adaptados.",
        },
        "competitor analysis": {
            "en": "Provider output did not match the contract; competitor analysis was withheld.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; a análise da concorrência foi retida.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; a análise da concorrência foi retida.",
        },
        "content gaps": {
            "en": "Provider output did not match the contract; content gaps were withheld.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; as lacunas de conteúdo foram retidas.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; as lacunas de conteúdo foram retidas.",
        },
        "SEO clusters": {
            "en": "Provider output did not match the contract; SEO clusters were withheld.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; os grupos de SEO foram retidos.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; os grupos de SEO foram retidos.",
        },
        "feedback analysis": {
            "en": "Provider output did not match the contract; feedback analysis was withheld.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; a análise do desempenho foi retida.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; a análise do desempenho foi retida.",
        },
        "performance report": {
            "en": "Provider output did not match the contract; generated report insights were withheld.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; as conclusões geradas do relatório foram retidas.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; os insights gerados do relatório foram retidos.",
        },
        "hot-news topics": {
            "en": "Provider output did not match the contract; registered search results were used instead.",
            "pt-PT": "A saída do fornecedor não correspondeu ao contrato; foram usados os resultados de pesquisa registados.",
            "pt-BR": "A saída do provedor não correspondeu ao contrato; os resultados de pesquisa registrados foram usados.",
        },
    }
    if locale == "pt-pt":
        return messages[output_name]["pt-PT"]
    if locale == "pt-br":
        return messages[output_name]["pt-BR"]
    return messages[output_name]["en"]


def localized_research_warning(language: str, output_name: str) -> str:
    """Return a stable review code plus localized research-health context."""
    locale = (language or "en-US").strip().lower()
    localized_names = {
        "pt-pt": {
            "content gaps": "lacunas de conteúdo",
            "SEO analysis": "análise de SEO",
            "competitor analysis": "análise da concorrência",
            "hot-news topics": "tópicos de notícias atuais",
            "hot-news sources": "fontes de notícias atuais",
            "research sources": "fontes de pesquisa",
            "trending sources": "fontes de tendências",
            "reaction sources": "fontes de reação",
        },
        "pt-br": {
            "content gaps": "lacunas de conteúdo",
            "SEO analysis": "análise de SEO",
            "competitor analysis": "análise de concorrentes",
            "hot-news topics": "tópicos de notícias recentes",
            "hot-news sources": "fontes de notícias recentes",
            "research sources": "fontes de pesquisa",
            "trending sources": "fontes de tendências",
            "reaction sources": "fontes de reação",
        },
    }
    if locale == "pt-pt":
        localized_name = localized_names["pt-pt"].get(output_name, "esta operação")
        message = f"A evidência de pesquisa para {localized_name} está indisponível ou incompleta; reveja antes de utilizar estimativas geradas."
    elif locale == "pt-br":
        localized_name = localized_names["pt-br"].get(output_name, "esta operação")
        message = f"As evidências de pesquisa para {localized_name} estão indisponíveis ou incompletas; revise antes de usar estimativas geradas."
    else:
        message = f"Research evidence for {output_name} is unavailable or incomplete; review before using generated estimates."
    return f"research_unavailable_review_required: {message}"


def validate_model_list(
    value: object,
    model: type[CreativeOutputModel],
    *,
    expected_items: int,
    wrapper_key: str | None = None,
) -> list[CreativeOutputModel]:
    """Validate an exact-size list; exact models reject uncontracted provider fields."""
    candidate = value
    if isinstance(candidate, dict):
        if "raw" in candidate:
            raise CreativeOutputContractError("provider_output_invalid")
        candidate = candidate.get(wrapper_key) if wrapper_key else None
    if not isinstance(candidate, list) or len(candidate) != expected_items:
        raise CreativeOutputContractError("provider_output_invalid")

    try:
        return [model.model_validate(item) for item in candidate]
    except (TypeError, ValidationError, ValueError):
        raise CreativeOutputContractError("provider_output_invalid") from None


def validate_bounded_model_list(
    value: object,
    model: type[CreativeOutputModel],
    *,
    min_items: int,
    max_items: int,
) -> list[CreativeOutputModel]:
    """Validate a provider list within an operation-specific cardinality bound."""
    if not isinstance(value, list) or not min_items <= len(value) <= max_items:
        raise CreativeOutputContractError("provider_output_invalid")
    try:
        return [model.model_validate(item) for item in value]
    except (TypeError, ValidationError, ValueError):
        raise CreativeOutputContractError("provider_output_invalid") from None


def validate_model_object(
    value: object,
    model: type[CreativeOutputModel],
) -> CreativeOutputModel:
    """Validate one provider object without carrying raw fallback text forward."""
    if not isinstance(value, dict) or "raw" in value:
        raise CreativeOutputContractError("provider_output_invalid")
    try:
        return model.model_validate(value)
    except (TypeError, ValidationError, ValueError):
        raise CreativeOutputContractError("provider_output_invalid") from None
