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

## Media: the backing track

The image carries no audio. With `media.enabled`, the chart creates a PVC (or
uses `media.existingClaim`) and mounts it read-only over `/app/dist/media`.
Whatever `track.json` on it names is what plays:

```json
{ "src": "night-drive.mp3", "title": "Night Drive", "artist": "kr4t0n", "cover": "night-drive.webp" }
```

`src` and `cover` are bare file names beside the manifest; `cover` is optional.
Give every song its own file names, because the audio is cached for an hour and
only the manifest is not.

Changing the song takes no release and no restart. The pod's own mount is
read-only, so files go on through a short-lived loader pod on the same node; a
ReadWriteOnce volume is attached to one node only:

```bash
NS=homepage CLAIM=homepage-media
NODE=$(kubectl -n $NS get pod -l app.kubernetes.io/name=homepage -o jsonpath='{.items[0].spec.nodeName}')
kubectl -n $NS run media-loader --image=busybox:1.37 --restart=Never \
  --overrides="{\"spec\":{\"nodeName\":\"$NODE\",\"volumes\":[{\"name\":\"m\",\"persistentVolumeClaim\":{\"claimName\":\"$CLAIM\"}}],\"containers\":[{\"name\":\"media-loader\",\"image\":\"busybox:1.37\",\"command\":[\"sleep\",\"3600\"],\"volumeMounts\":[{\"name\":\"m\",\"mountPath\":\"/media\"}]}]}}"
kubectl -n $NS wait --for=condition=Ready pod/media-loader
kubectl -n $NS cp night-drive.mp3  media-loader:/media/night-drive.mp3
kubectl -n $NS cp night-drive.webp media-loader:/media/night-drive.webp
kubectl -n $NS cp track.json       media-loader:/media/track.json   # last
kubectl -n $NS delete pod media-loader
```

The manifest goes last so it never names a file that is not there yet. Old
songs can be deleted the same way once nothing names them.

The chart's PVC carries `helm.sh/resource-policy: keep`, so `helm uninstall`
leaves the songs in place. Remove the claim by hand when they should go too.

## The image

Each chart version pins the image built for it: `appVersion` equals `version`,
so chart 0.1.1 runs `kr4t0n/homepage:0.1.1`. Installing a chart version
therefore installs a fixed build, and `helm rollback` rolls back the site as
well as the manifest. Set `image.tag` only to run something else, such as a
`sha-<short>` build from `main`.

`image.pullPolicy` is empty by default, which lets Kubernetes choose `Always`
for `latest` and `IfNotPresent` for anything else.

The backing track is never in the image; it comes from the media volume above.

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
`argus`, `media` and `ingress`.

## Releasing

1. Bump `version` and `appVersion` in `Chart.yaml` to the same value, and
   merge to `main`. `helm-publish.yml` packages and indexes it, and never
   rewrites a version that is already published.
2. Tag the merge commit `v<version>` and push the tag. `image.yml` builds and
   pushes `kr4t0n/homepage:<version>`.

Both halves are needed. Until the git tag is pushed, the new chart version
points at an image that does not exist, and a pod installed from it sits in
`ImagePullBackOff`. Pushing the tag late fixes that without republishing.
