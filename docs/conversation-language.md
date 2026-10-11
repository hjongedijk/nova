# Conversation language

Choose Nederlands or English in the chat composer. The selection is stored in
this browser for the current conversation and resets when you clear that
conversation. NOVA uses it for model answers, confirmation questions, tool
progress, confirmation cards and actions, and spoken replies. Voice recognition
listens in the same language. Client-generated fallbacks use the same language.

NOVA keeps the configured voice when it matches the selected language. If it
does not, Dutch uses Fenna and English uses Ryan; both are in the existing
voice catalog. The voice preference itself is unchanged. Language is a local
conversation preference and is sent with chat requests as a two-value enum.
