# syntax=docker/dockerfile:1.7
# Build from environments/: docker buildx build -f fea/Dockerfile --platform linux/arm64,linux/amd64 .
FROM mambaorg/micromamba:2.9.0-ubuntu24.04

LABEL org.opencontainers.image.source="https://github.com/SupraluminalIntelligence/beam" \
      org.opencontainers.image.description="Beam fea environment: FEniCSx, gmsh, pyvista and beam_out" \
      org.opencontainers.image.licenses="MIT"

# Exact packages per architecture, generated from base/ and fea/environment.yml by ./lock.sh fea.
ARG TARGETARCH
COPY --chown=$MAMBA_USER:$MAMBA_USER fea/lock/linux-${TARGETARCH}.txt /tmp/lock.txt
RUN micromamba install -y -n base --file /tmp/lock.txt \
 && micromamba clean --all --yes

USER root
COPY base/beam_out /opt/beam/python/beam_out
COPY fea/env.md fea/env.json /beam/
COPY fea/benchmarks /beam/benchmarks
RUN mkdir -p /work && chmod 1777 /work \
 && micromamba list -n base --json > /beam/packages.json

ENV PATH=/opt/conda/bin:$PATH \
    PYTHONPATH=/opt/beam/python \
    PYVISTA_OFF_SCREEN=true \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MPIR_CVAR_CH4_NETMOD=ofi \
    BEAM_ENVIRONMENT=fea
WORKDIR /work
USER $MAMBA_USER
