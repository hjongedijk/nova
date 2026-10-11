FROM python:3.12-slim

RUN python3 -m pip install --no-cache-dir --break-system-packages 'piper-tts[http]==1.8.0'
WORKDIR /tmp
USER 1000:1000
EXPOSE 5000
