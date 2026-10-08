# homepage Helm chart

Deploys the homepage: one container serving the built site and the
`/api/pixels` proxy that lights the two wall boards from Argus.

```bash
helm repo add homepage https://kr4t0n.github.io/homepage/helm
helm repo update
helm install homepage homepage/homepage
```

## Argus is optional

Without it the room renders normally and the wall boards stay unlit. To light
them, give the chart the Argus API base URL and a key, inline or by reference:

```bash
helm install homepage homepage/homepage \
  --set argus.url=http://argus-server.argus.svc.cluster.local:4000 \
  --set argus.existingSecret=homepage-secret   # carries ARGUS_KEY
```

`argus.apiKey` instead of `existingSecret` puts the key in a chart-generated
Secret, and a change to it rolls the pods. A Secret managed elsewhere is not
tracked: roll the Deployment yourself after rotating the key.

The chart refuses a URL without a key, a key without a URL, and a URL without
a scheme. Each of those installs and runs, then answers 502 on every poll in
a way that is indistinguishable from an Argus outage.

Prefer the in-cluster service address over the public ingress, so the request
never leaves the cluster.

## The image

Each chart version pins the image built for it: `appVersion` equals `version`,
so chart 0.1.1 runs `kr4t0n/homepage:0.1.1`. Installing a chart version
therefore installs a fixed build, and `helm rollback` rolls back the site as
well as the manifest. Set `image.tag` only to run something else, such as a
`sha-<short>` build from `main`.

`image.pullPolicy` is empty by default, which lets Kubernetes choose `Always`
for `latest` and `IfNotPresent` for anything else.

The backing track is not in the image and no value adds it; see the main
README for why.

## Defaults worth knowing

- **Locked-down pod.** Non-root as uid 1000, read-only root filesystem, every
  capability dropped, `RuntimeDefault` seccomp. Verified against the published
  image with `docker run --read-only --user 1000:1000 --cap-drop ALL`.
- **Probes on `/api/health`**, which never touches Argus, so an upstream outage
  cannot restart a healthy pod.
- **A 5 second `preStop` sleep** (`shutdownDelaySeconds`), so the ingress
  controller stops routing to a terminating pod before the server stops
  accepting. Uses the native `sleep` action, hence `kubeVersion >= 1.30`.
- **Requests of 10m CPU and 96Mi, a 256Mi memory limit, no CPU limit.** The
  server measured ~64 MiB resident under light concurrent load.

## Values

See `values.yaml`, which is commented. The ones that matter most are
`argus` and `ingress`.

## Releasing

1. Bump `version` and `appVersion` in `Chart.yaml` to the same value, and
   merge to `main`. `helm-publish.yml` packages and indexes it, and never
   rewrites a version that is already published.
2. Tag the merge commit `v<version>` and push the tag. `image.yml` builds and
   pushes `kr4t0n/homepage:<version>`.

Both halves are needed. Until the git tag is pushed, the new chart version
points at an image that does not exist, and a pod installed from it sits in
`ImagePullBackOff`. Pushing the tag late fixes that without republishing.
