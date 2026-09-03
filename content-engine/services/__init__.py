__all__ = ["ResearchOrchestrator", "score_results", "build_briefs"]


def __getattr__(name: str):
    """Preserve package exports without eagerly loading the research graph."""
    if name == "ResearchOrchestrator":
        from .orchestrator import ResearchOrchestrator

        return ResearchOrchestrator
    if name == "score_results":
        from .scorer import score_results

        return score_results
    if name == "build_briefs":
        from .brief_builder import build_briefs

        return build_briefs
    raise AttributeError(name)
