# syntax=docker/dockerfile:1.7
# Build from environments/: docker buildx build -f cfd/Dockerfile --platform linux/arm64,linux/amd64 .
# OpenFOAM 2512 from OpenCFD's pinned multi-arch image, plus the shared Python base and beam_out.
FROM mambaorg/micromamba:2.9.0-ubuntu24.04 AS micromamba
FROM opencfd/openfoam-default:2512@sha256:33fb575aa9980d2bc42fd58c75ae698c489293ba30c991380fe3f899c622f319

LABEL org.opencontainers.image.source="https://github.com/SupraluminalIntelligence/beam" \
      org.opencontainers.image.description="Beam cfd environment: OpenFOAM 2512, pyvista and beam_out" \
      org.opencontainers.image.licenses="MIT"

USER root
COPY --from=micromamba /bin/micromamba /usr/local/bin/micromamba
ENV MAMBA_ROOT_PREFIX=/opt/conda
# Exact packages per architecture, generated from base/ and cfd/environment.yml by ./lock.sh cfd.
ARG TARGETARCH
COPY cfd/lock/linux-${TARGETARCH}.txt /tmp/lock.txt
RUN micromamba create -y -p /opt/conda --file /tmp/lock.txt && micromamba clean --all --yes

COPY base/beam_out /opt/beam/python/beam_out
COPY cfd/env.md cfd/env.json /beam/
COPY cfd/benchmarks /beam/benchmarks
RUN mkdir -p /work && chmod 1777 /work \
 && micromamba list -p /opt/conda --json > /beam/packages.json

# OpenFOAM's own environment loads in login shells (/etc/profile.d/openfoam-99run.sh); jobs run bash -lc.
ENV PATH=/opt/conda/bin:$PATH \
    PYTHONPATH=/opt/beam/python \
    PYVISTA_OFF_SCREEN=true \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    BEAM_ENVIRONMENT=cfd
WORKDIR /work
ENTRYPOINT []
CMD ["bash", "-l"]
