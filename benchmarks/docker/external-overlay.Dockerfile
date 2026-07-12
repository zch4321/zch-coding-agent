# syntax=docker/dockerfile:1.7
ARG ZCH_RUNTIME_IMAGE
ARG TASK_IMAGE

FROM ${ZCH_RUNTIME_IMAGE} AS zch-runtime
FROM ${TASK_IMAGE}

USER root
ARG TASK_WORKSPACE
ARG ZCH_SOURCE_COMMIT=development
ARG ZCH_SOURCE_TREE_STATE=unknown
RUN test -n "${TASK_WORKSPACE}" \
  && test -d "${TASK_WORKSPACE}" \
  && mkdir -p /home/zch \
  && chown -R 10001:10001 "${TASK_WORKSPACE}" /home/zch
COPY --from=zch-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=zch-runtime /usr/bin/tini /usr/bin/tini
COPY --from=zch-runtime /usr/local/bin/zch-worker /usr/local/bin/zch-worker
COPY --from=zch-runtime /opt/zch /opt/zch
LABEL org.opencontainers.image.title="Zch Agent External Task Worker" \
  org.opencontainers.image.revision="${ZCH_SOURCE_COMMIT}" \
  com.zch.source-tree="${ZCH_SOURCE_TREE_STATE}" \
  com.zch.runtime.platform="linux-x64" \
  com.zch.runtime.libc="glibc" \
  com.zch.runtime.node="v24"
ENV HOME=/home/zch
WORKDIR ${TASK_WORKSPACE}
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/zch-worker"]
CMD ["run"]
