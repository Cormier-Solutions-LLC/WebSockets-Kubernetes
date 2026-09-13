{{- define "realtime-gateway.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "realtime-gateway.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{ else }}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{ end -}}
{{- end -}}
{{- define "realtime-gateway.labels" -}}
app.kubernetes.io/name: {{ include "realtime-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}
{{- define "realtime-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ include "realtime-gateway.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "realtime-gateway.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ default (include "realtime-gateway.fullname" .) .Values.serviceAccount.name }}{{ else }}{{ required "serviceAccount.name is required when create=false" .Values.serviceAccount.name }}{{ end -}}
{{- end -}}
{{- define "realtime-gateway.redisEndpoint" -}}
{{- if and (eq .Values.redis.mode "managed") (eq .Values.topology "ha") -}}{{ printf "%s:%v" .Values.redis.managedReleaseName .Values.redis.sentinelPort }}{{- else if eq .Values.redis.mode "managed" -}}{{ printf "%s-master:%v" .Values.redis.managedReleaseName .Values.redis.port }}{{- else -}}{{ required "redis.externalEndpoint is required in external mode" .Values.redis.externalEndpoint }}{{- end -}}
{{- end -}}
