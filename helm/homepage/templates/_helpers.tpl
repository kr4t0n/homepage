{{/*
Expand the name of the chart.
*/}}
{{- define "homepage.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
A "fullname" prefix used by every resource. Honors fullnameOverride and falls
back to "<release>-<chart>", so two releases can coexist in one namespace.
*/}}
{{- define "homepage.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Common labels shared by every object. The name/instance pair is what
`kubectl logs -l app.kubernetes.io/instance=<release>` keys off.
*/}}
{{- define "homepage.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "homepage.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "homepage.tag" . | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/*
Selector labels. Deliberately excludes version and chart: Kubernetes rejects
mutating a Deployment's selector, so anything that changes on upgrade cannot
live here.
*/}}
{{- define "homepage.selectorLabels" -}}
app.kubernetes.io/name: {{ include "homepage.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Explicit tag wins, then Chart.AppVersion, so an unconfigured chart still pulls
a matching release.
*/}}
{{- define "homepage.tag" -}}
{{- default .Chart.AppVersion .Values.image.tag -}}
{{- end -}}

{{- define "homepage.image" -}}
{{- $reg := .Values.image.registry | default "docker.io" -}}
{{- printf "%s/%s:%s" $reg .Values.image.repository (include "homepage.tag" .) -}}
{{- end -}}

{{/*
The claim is named for what it holds rather than `-data`, so it reads as the
songs volume in `kubectl get pvc`.
*/}}
{{- define "homepage.pvcName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-media" (include "homepage.fullname" .)) -}}
{{- end -}}

{{/*
Fail early with a readable message rather than rendering something half broken.

A URL without a scheme still installs and runs: the server logs one line and
/api/pixels answers 502 forever. That looks exactly like a Prometheus outage,
so it is refused here instead. So is a leftover `argus` block, which nothing
reads any more: left as is, the boards would go dark with no error.
*/}}
{{- define "homepage.validate" -}}
{{- if .Values.argus -}}
{{- fail "The wall boards no longer read Argus: the `argus` values block was replaced by `prometheus.url`, which takes no key. Set prometheus.url and remove the `argus` block and its Secret." -}}
{{- end -}}
{{- if and .Values.prometheus.url (not (regexMatch "^https?://" .Values.prometheus.url)) -}}
{{- fail (printf "prometheus.url must start with http:// or https://, got %q." .Values.prometheus.url) -}}
{{- end -}}
{{- if .Values.media -}}
{{- fail "The `media` values block was renamed to `persistence` in chart 0.1.3. Move its keys across; left as is, the volume would silently not be mounted." -}}
{{- end -}}
{{- if and .Values.persistence.existingClaim (not .Values.persistence.enabled) -}}
{{- fail "persistence.existingClaim is set but persistence.enabled is false, so the claim would never be mounted. Set persistence.enabled=true, or clear the claim." -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not .Values.ingress.hosts) -}}
{{- fail "ingress.enabled is true but ingress.hosts is empty." -}}
{{- end -}}
{{- end -}}
