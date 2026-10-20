{{/*
Expand the name of the chart.
*/}}
{{- define "nakama.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this.
*/}}
{{- define "nakama.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "nakama.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "nakama.labels" -}}
helm.sh/chart: {{ include "nakama.chart" . }}
{{ include "nakama.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "nakama.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nakama.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Database connection string helper
*/}}
{{- define "nakama.databaseAddress" -}}
{{- if .Values.database.password }}
{{- printf "%s:%s@%s:%d/%s?sslmode=%s" .Values.database.username .Values.database.password .Values.database.host (int .Values.database.port) .Values.database.name .Values.database.sslMode }}
{{- else }}
{{- printf "%s@%s:%d/%s?sslmode=%s" .Values.database.username .Values.database.host (int .Values.database.port) .Values.database.name .Values.database.sslMode }}
{{- end }}
{{- end }}

