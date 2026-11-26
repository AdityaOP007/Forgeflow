{{- define "service-chart.name" -}}
{{- .Values.name | default .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "service-chart.labels" -}}
app.kubernetes.io/name: {{ include "service-chart.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: forgeflow
forgeflow.io/environment: development
{{- end -}}

{{- define "service-chart.selectorLabels" -}}
app.kubernetes.io/name: {{ include "service-chart.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "service-chart.dbHost" -}}
{{ include "service-chart.name" . }}-postgres
{{- end -}}

