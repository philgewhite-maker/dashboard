# python:3-slim rather than -alpine, and one dependency rather than none.
#
# Both changes are for curl_cffi, which is what lets page.fetch look like
# a browser at the TLS and HTTP/2 level rather than merely in its headers.
# That matters because Agent Provocateur serves TWO different pages at the
# same URL: 194KB with the whole product set to a browser, 15KB with only
# the main garment to urllib — measured, same URL, same minute, same
# connection. Headers, cookies and a browser User-Agent made no difference
# to that; the deciding factor sits below them.
#
# Alpine is musl, and curl_cffi ships manylinux (glibc) wheels, so on
# alpine pip would try to build it from source and need a compiler
# toolchain in the image. Debian slim is a few MB larger and installs a
# prebuilt wheel in seconds.
#
# The agent still RUNS without it: page.fetch falls back to urllib if the
# import fails, so a build that cannot reach PyPI degrades to what it did
# before rather than failing to start.
FROM python:3-slim

WORKDIR /app

RUN pip install --no-cache-dir "curl_cffi>=0.7"

COPY agent.py /app/agent.py

# Unbuffered, so `docker logs` shows what it's doing as it happens rather
# than in bursts when a buffer fills.
ENV PYTHONUNBUFFERED=1

# No root: it only makes outbound HTTP calls, and never touches the
# filesystem beyond reading its own script.
USER nobody

CMD ["python", "/app/agent.py"]
