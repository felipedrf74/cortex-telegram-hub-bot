"""
Verified Source Registry — trusted sources for fact verification.
Used by the accuracy review step to validate claims in generated scripts.
"""

# Tier 1 — Primary / Official Sources (Highest Trust)
TIER_1_SOURCES = {
    "politics_br": [
        {"name": "TSE", "url": "https://www.tse.jus.br", "scope": "Election rulings, candidate eligibility"},
        {"name": "STF", "url": "https://portal.stf.jus.br", "scope": "Supreme Court decisions"},
        {"name": "Planalto", "url": "https://www.gov.br/planalto", "scope": "Official government communications"},
        {"name": "Câmara dos Deputados", "url": "https://www.camara.leg.br", "scope": "Legislation, voting records"},
        {"name": "Senado Federal", "url": "https://www.senado.leg.br", "scope": "Senate proceedings"},
        {"name": "Diário Oficial", "url": "https://www.in.gov.br/servicos/diario-oficial-da-uniao", "scope": "Legal publications"},
    ],
    "health_science": [
        {"name": "PubMed", "url": "https://pubmed.ncbi.nlm.nih.gov", "scope": "Peer-reviewed medical papers"},
        {"name": "Examine.com", "url": "https://examine.com", "scope": "Evidence-based supplement analysis"},
        {"name": "Cochrane Library", "url": "https://www.cochranelibrary.com", "scope": "Systematic reviews"},
        {"name": "WADA", "url": "https://www.wada-ama.org", "scope": "Anti-doping, prohibited substances"},
        {"name": "ACSM", "url": "https://www.acsm.org", "scope": "Exercise science position stands"},
    ],
    "general": [
        {"name": "Reuters", "url": "https://www.reuters.com", "scope": "Wire service, factual reporting"},
        {"name": "Associated Press", "url": "https://apnews.com", "scope": "Wire service, factual reporting"},
        {"name": "AFP", "url": "https://www.france24.com", "scope": "International wire service"},
    ],
}

# Tier 2 — Reputable Journalism (High Trust, Verify Key Claims)
TIER_2_SOURCES = {
    "br_news": [
        {"name": "Folha de São Paulo", "url": "https://www.folha.uol.com.br"},
        {"name": "O Globo", "url": "https://oglobo.globo.com"},
        {"name": "Estadão", "url": "https://www.estadao.com.br"},
        {"name": "G1", "url": "https://g1.globo.com"},
        {"name": "Poder360", "url": "https://www.poder360.com.br"},
        {"name": "BBC Brasil", "url": "https://www.bbc.com/portuguese"},
    ],
    "intl_news": [
        {"name": "BBC News", "url": "https://www.bbc.com"},
        {"name": "Bloomberg", "url": "https://www.bloomberg.com"},
    ],
    "fitness": [
        {"name": "Stronger by Science", "url": "https://www.strongerbyscience.com"},
        {"name": "Barbell Medicine", "url": "https://www.barbellmedicine.com"},
    ],
}

# Fact-checking services
FACT_CHECKERS = [
    {"name": "Agência Lupa", "url": "https://lupa.uol.com.br", "lang": "pt-BR"},
    {"name": "Aos Fatos", "url": "https://www.aosfatos.org", "lang": "pt-BR"},
    {"name": "AFP Checamos", "url": "https://checamos.afp.com/pt", "lang": "pt-BR"},
    {"name": "Reuters Fact Check", "url": "https://www.reuters.com/fact-check", "lang": "en"},
]

# High-risk claim categories that MUST be verified
HIGH_RISK_CATEGORIES = [
    "political_status",      # Who holds office, eligibility, party affiliation
    "legal_outcome",         # Court decisions, sentences, appeals
    "election_data",         # Candidates, polls, results
    "economic_statistics",   # GDP, inflation, exchange rates
    "health_claims",         # Supplement efficacy, training methodology
    "person_status",         # Alive/dead, current role, legal status
    "recent_events",         # Anything that may have changed in last 12 months
]


def get_verification_queries(topic: str, language: str | None = None) -> list[str]:
    """Generate targeted verification queries for high-risk claims in a topic."""
    queries = []

    normalized_language = (language or "").strip().lower()
    portuguese_language = normalized_language.startswith("pt")
    topic_lower = topic.lower()
    brazil_markers = [
        "bolsonaro", "lula", "brasil", "brazil", "stf", "tse", "selic", "ibge",
        "câmara dos deputados", "senado federal",
    ]
    brazil_context = normalized_language.startswith("pt-br") or any(
        marker in topic_lower for marker in brazil_markers
    )

    political_keywords = [
        "bolsonaro", "lula", "eleição", "eleições", "election", "elections", "candidate", "candidato", "inelegível",
        "president", "presidente", "governador", "prefeito", "ministro", "deputado", "senador",
        "condenado", "preso", "absolvido", "julgamento", "stf", "tse",
    ]
    if any(keyword in topic_lower for keyword in political_keywords):
        if brazil_context:
            queries.append(f"{topic} site:tse.jus.br OR site:portal.stf.jus.br")
            queries.append(f"{topic} situação atual Brasil")
        elif portuguese_language:
            queries.append(f"{topic} autoridade eleitoral oficial situação atual")
            queries.append(f"{topic} Reuters AP situação atual")
        else:
            queries.append(f"{topic} official election authority current status")
            queries.append(f"{topic} Reuters AP current status")

    # Economic keywords trigger data verification
    economic_keywords = [
        "inflação", "pib", "dólar", "selic", "desemprego", "economia",
        "imposto", "dívida", "fiscal", "orçamento",
        "inflation", "gdp", "currency", "interest rate", "unemployment", "economy",
        "tax", "debt", "budget", "exchange rate",
    ]
    if any(kw in topic_lower for kw in economic_keywords):
        if brazil_context:
            queries.append(f"{topic} dados atuais site:ibge.gov.br OR site:bcb.gov.br")
        elif portuguese_language:
            queries.append(f"{topic} dados oficiais atuais Eurostat OCDE Banco Mundial")
        else:
            queries.append(f"{topic} current official data OECD World Bank")
        queries.append(f"{topic} Bloomberg Reuters current data")

    # Health/fitness keywords
    health_keywords = [
        "suplemento", "treino", "dieta", "estudo", "pesquisa", "saúde",
        "carnívoro", "creatina", "proteína", "corrida", "maratona",
        "supplement", "training", "diet", "study", "research", "health",
        "creatine", "protein", "running", "marathon", "sleep", "recovery",
    ]
    if any(kw in topic_lower for kw in health_keywords):
        if portuguese_language:
            queries.append(f"{topic} revisão sistemática recente PubMed")
            queries.append(f"{topic} evidência científica Cochrane")
        else:
            queries.append(f"{topic} latest systematic review PubMed")
            queries.append(f"{topic} evidence review Cochrane")

    return queries
