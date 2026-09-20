# Standard library only, so there's nothing to pip install and nothing
# extra to keep patched -- just the interpreter and one file.
FROM python:3-alpine

WORKDIR /app
COPY agent.py /app/agent.py

# Unbuffered, so `docker logs` shows what it's doing as it happens rather
# than in bursts when a buffer fills.
ENV PYTHONUNBUFFERED=1

# No root: it only makes outbound HTTP calls, and never touches the
# filesystem beyond reading its own script.
USER nobody

CMD ["python", "/app/agent.py"]
