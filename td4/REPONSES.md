# TD4 — Réponses

Docker Engine 29.4.0 (OrbStack, Mac arm64), Compose v5.1.2. Projet `td4`.
Raccourci utilisé pour la prod :

```bash
P() { docker compose -f compose.yaml -f compose.prod.yaml "$@"; }
```

Mise en place : `cp .env.example .env`, puis (prod) `printf '<mot de passe>' > secrets/db_password.txt`.

---

## Partie A

### A1 — Démarrage fiable

Healthchecks ajoutés dans `compose.yaml` :

| Service | Test |
|---|---|
| `db` | `pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}` |
| `cache` | `redis-cli ping` |
| `api` | `wget -qO- http://localhost:3000/health` |

L'API a `depends_on: db/cache: condition: service_healthy`. J'ai retiré `restart: on-failure` : il ne servait qu'à
contourner le démarrage trop rapide de l'API.

**Quel outil HTTP dans `node:24-alpine` ?** `curl` n'y est pas, mais `wget` (BusyBox) oui :

```bash
docker run --rm node:24-alpine sh -c 'which wget curl'
# /usr/bin/wget          ← curl absent
```

**Plus de crash au démarrage** (volume vide, donc Postgres doit s'initialiser) :

```bash
docker compose down -v && docker compose up -d --build
#  Container td4-cache-1 Waiting
#  Container td4-db-1 Waiting
#  Container td4-cache-1 Healthy
#  Container td4-db-1 Healthy
#  Container td4-api-1 Started          ← l'API ne démarre qu'une fois db et cache sains
docker compose ps
# api     Up 12 seconds (healthy)
# cache   Up 14 seconds (healthy)
# db      Up 14 seconds (healthy)
docker compose logs api
# Connecting to Postgres at db:5432…
# Connecting to Redis at redis://cache:6379…
# Visites API listening on 3000         ← aucune erreur ECONNREFUSED
docker inspect td4-api-1 --format '{{.RestartCount}}'     # 0
```

**À quoi sert `$$` ?** Compose interpole lui-même les `${…}` du fichier, avec les variables de `.env` ou du shell.
`$$` est l'échappement : Compose le remplace par un `$` simple **sans** interpoler. C'est donc le shell **du
conteneur** qui lira `$POSTGRES_USER` au moment du test, avec la valeur de son propre environnement.

```bash
docker compose config | grep pg_isready
#   - pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}
docker inspect td4-db-1 --format '{{json .Config.Healthcheck.Test}}'
# ["CMD-SHELL","pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]      ← un seul $, lu dans le conteneur
```

Avec un seul `$`, Compose cherche `POSTGRES_USER` sur la machine. Elle n'y existe pas, donc la commande devient
`pg_isready -U ` (vide) :

```
level=warning msg="The \"POSTGRES_USER\" variable is not set. Defaulting to a blank string."
  - 'pg_isready -U '
```

### A2 — Trois fichiers

| Fichier | Contenu |
|---|---|
| `compose.yaml` | services, volumes, healthchecks, `depends_on` sains. **Aucun port, aucun mot de passe.** |
| `compose.override.yaml` | cible `dev`, `develop.watch`, API sur `${API_DEV_PORT:-3000}`, base sur `${DB_HOST_PORT:-5432}`, mot de passe lu dans `.env` |
| `compose.prod.yaml` | `image: ${API_IMAGE:-td4-api}`, API sur `${API_PORT:-8000}`, `restart: unless-stopped` partout, mot de passe en secret (A5), durcissement (B2) |

```bash
docker compose -f compose.yaml config | grep -E 'published|PASSWORD'
# (rien)                                   ← la base ne publie ni port ni mot de passe
P config | grep -E 'published|restart|image: td4'
#     image: td4-api
#         published: "8000"                ← seule l'API est publiée
#     restart: unless-stopped              (×3)
docker compose config | grep published
#         published: "3000"                ← dev : API…
#         published: "5432"                ← … et base, pour le client SQL
```

Dans le dev, j'ai nommé le port de l'API `API_DEV_PORT`. Si `.env` contenait `API_PORT=3000`, la prod
(`${API_PORT:-8000}`) le lirait aussi et publierait l'API sur 3000 au lieu de 8000.

**Pourquoi la base ne doit publier aucun port ?** Les fichiers Compose se **fusionnent**, et un fichier ajouté peut
ajouter des ports, mais **pas en retirer** : les listes `ports` s'additionnent. Un port publié dans `compose.yaml`
serait donc publié aussi en prod, et Postgres serait exposé sur le réseau de la machine. Or, en prod, la base ne doit
être joignable que par l'API, sur le réseau interne du projet. Chaque environnement ajoute ce dont il a besoin : le
dev publie 5432 pour le client SQL, la prod ne publie que l'API.

### A3 — La prod

```bash
P up -d --build
P ps
# api     Up 8 seconds (healthy)    0.0.0.0:8000->3000/tcp
# cache   Up 10 seconds (healthy)   6379/tcp
# db      Up 10 seconds (healthy)   5432/tcp          ← port interne, non publié
P exec api sh -c 'ps -o user,args | sed -n 2p'
# node     node src/server.js                          ← bien la cible prod, pas la dev

curl localhost:8000   # {"hitsInRedis":1,"visitsInPostgres":1,…}
curl localhost:8000   # … 2 …
curl localhost:8000   # … 3 …
curl localhost:8000   # {"hitsInRedis":4,"visitsInPostgres":4,"servedBy":"df00a9da0f74"}

P down
#  Container td4-api-1 Removed / td4-cache-1 Removed / td4-db-1 Removed / Network td4_default Removed
docker volume ls --filter name=td4
# local     td4_pgdata
# local     td4_redisdata
P up -d
curl localhost:8000
# {"hitsInRedis":5,"visitsInPostgres":5,"servedBy":"74448a844616"}
```

**Les deux compteurs ont survécu** (5 = suite de 4). `down` supprime les conteneurs et le réseau, mais pas les
volumes nommés `td4_pgdata` et `td4_redisdata`. Les nouveaux conteneurs `db` et `cache` y retrouvent leurs données.

**La base n'est pas joignable depuis la machine :**

```bash
pg_isready -h localhost -p 5432       # localhost:5432 - no response
nc -z -w 2 localhost 5432             # (échec) → port fermé
```

…mais elle l'est depuis l'API, sur le réseau du projet :

```bash
P exec api getent hosts db                                            # 192.168.107.3   db
P exec api node -e "require('net').connect(5432,'db').on('connect',()=>console.log('OK'))"   # OK
```

C'est voulu : en prod, seul le point d'entrée (l'API) est exposé. Une base publiée serait une cible directe (force
brute du mot de passe, failles de Postgres) pour quiconque atteint la machine. Personne d'autre que l'API n'a besoin
d'y parler.

### A4 — Un arrêt propre

```bash
time P stop api                      # 0,25 s
P ps -a
# api     Exited (0) Less than a second ago
P logs api | tail -1
# SIGTERM received, shutting down
```

- **Durée : 0,25 s**, au lieu des 10 s du délai de grâce (cf. `dormeur` au TD1).
- **Code 0** : l'app s'est terminée **d'elle-même, normalement**. Elle a reçu SIGTERM, son gestionnaire
  `process.on('SIGTERM')` a fermé le serveur HTTP, Postgres et Redis, puis appelé `process.exit(0)`. Docker n'a pas eu
  besoin de la tuer (ce serait 137 = SIGKILL). Deux conditions : le `CMD` est entre crochets, donc `node` est PID 1 et
  reçoit le signal, et l'app gère SIGTERM.

**`restart: unless-stopped` après un `docker stop` :** il ne fait **rien**. Le conteneur reste arrêté, puisque c'est
nous qui l'avons arrêté :

```bash
sleep 15; P ps -a | grep api        # api   Exited (0) 15 seconds ago
```

Il redémarrerait seulement si on le relançait (`start`/`up`). Après un redémarrage du démon ou de la machine, il
reste arrêté, contrairement à `always`.

**Et s'il plante ?** Il redémarre tout seul. Pour simuler un vrai plantage, le processus doit mourir **sans passer par
Docker**. `docker kill` compte comme un arrêt manuel : testé, le conteneur reste `exited`, `RestartCount=0`. J'ai
donc tué le PID de l'API directement dans la VM Linux :

```bash
PID=$(docker inspect td4-api-1 --format '{{.State.Pid}}')
docker run --rm --pid=host --privileged alpine kill -9 $PID
docker inspect td4-api-1 --format '{{.State.Status}} RestartCount={{.RestartCount}}'
# running RestartCount=1
docker events --filter container=td4-api-1
# die 137 → start                       ← mort brutale, Docker le relance aussitôt
curl localhost:8000                     # {"hitsInRedis":6,…}
```

### A5 (bonus) — Le mot de passe en secret

`compose.prod.yaml` déclare un secret `db_password` (fichier `secrets/db_password.txt`, ignoré par git). Postgres le
lit via `POSTGRES_PASSWORD_FILE`, l'API via `DB_PASSWORD_FILE`. Les deux sont montés en `/run/secrets/db_password`.

**Avant** (mot de passe en variable d'environnement) :

```bash
docker inspect td4-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i pass
# DB_PASSWORD=s3cr3t-local
docker inspect td4-db-1  --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i pass
# POSTGRES_PASSWORD=s3cr3t-local
```

**Après** (secret) :

```bash
docker inspect td4-api-1 … | grep -i pass
# DB_PASSWORD_FILE=/run/secrets/db_password          ← seulement le chemin
docker inspect td4-db-1 … | grep -i pass
# POSTGRES_PASSWORD_FILE=/run/secrets/db_password
P exec api ls -l /run/secrets/
# -rw-r--r--  1 node  node  12  db_password
curl localhost:8000          # {"hitsInRedis":7,"visitsInPostgres":7,…}   ← l'app se connecte toujours
```

La valeur n'apparaît plus dans `docker inspect`, ni donc dans tout ce qui l'affiche (outils de supervision, logs de
déploiement, `docker compose config`). Elle n'est lisible que dans le fichier, à l'intérieur du conteneur.

---

## Partie B

```bash
trivy() { docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache aquasec/trivy:0.74.0 "$@"; }
```

(Une fonction plutôt qu'un `alias` : zsh n'étend pas les alias dans un script.)

### B1 — Un secret de build qui ne fuit pas

Jeton simulé : `token.txt` (ignoré par git) contient `tok_9f3a7c-PRIVE`.

**1. Avec `ARG` :**

```dockerfile
FROM base AS prod
ARG TOKEN
RUN echo "téléchargement avec le jeton $TOKEN"
```

```bash
docker build --target prod --build-arg TOKEN=$(cat token.txt) -t td4-api:argtoken app
docker history --no-trunc td4-api:argtoken --format '{{.CreatedBy}}' | grep tok_
# RUN |1 TOKEN=tok_9f3a7c-PRIVE /bin/sh -c npm ci --omit=dev # buildkit
# RUN |1 TOKEN=tok_9f3a7c-PRIVE /bin/sh -c echo "téléchargement avec le jeton $TOKEN" # buildkit
# ARG TOKEN=tok_9f3a7c-PRIVE
docker save td4-api:argtoken | grep -a -o 'TOKEN=tok_[A-Za-z0-9_-]*' | sort -u
# TOKEN=tok_9f3a7c-PRIVE
```

C'est **`docker history --no-trunc`** qui livre le jeton : la valeur d'un `ARG` est enregistrée dans les métadonnées
de **chaque** instruction `RUN` qui suit, et ces métadonnées font partie de l'image. N'importe qui ayant l'image (un
`docker pull` suffit) peut la lire.

**2. Avec un secret monté :**

```dockerfile
FROM base AS prod
RUN --mount=type=secret,id=token \
    echo "téléchargement avec le jeton $(cat /run/secrets/token)"
```

```bash
docker build --no-cache --progress=plain --target prod --secret id=token,src=token.txt -t td4-api:secrettoken app
# #8 0.099 téléchargement avec le jeton tok_9f3a7c-PRIVE      ← le jeton est bien utilisé pendant le build
docker history --no-trunc td4-api:secrettoken | grep -c tok_      # 0
docker history --no-trunc td4-api:secrettoken --format '{{.CreatedBy}}' | grep secret
# RUN /bin/sh -c echo "téléchargement avec le jeton $(cat /run/secrets/token)"   ← la commande, pas la valeur
docker save td4-api:secrettoken | grep -a -c tok_                  # 0
docker run --rm td4-api:secrettoken ls /run/secrets
# ls: /run/secrets: No such file or directory
```

**Pourquoi aucune trace :** le secret est monté **temporairement** (un tmpfs en `/run/secrets/token`), **le temps
de ce seul `RUN`**. Il ne fait partie ni du contexte de build, ni d'une couche : le contenu du montage n'est jamais
écrit dans le système de fichiers de l'image. L'historique ne garde que le texte de la commande, avec
`$(cat /run/secrets/token)` et non la valeur. Attention quand même : si la commande **écrivait** le jeton dans un
fichier de l'image, ou l'affichait dans les logs de build (comme ici, pour la démo), il fuirait par là.

Le secret n'est pas obligatoire : `docker build` sans `--secret` (Compose, CI) fonctionne toujours.

### B2 — Durcir l'API

`compose.prod.yaml`, service `api` : `read_only: true`, `tmpfs: [/tmp]`, `cap_drop: [ALL]`, `mem_limit: 256m`.

**L'app fonctionne toujours :**

```bash
P up -d --build
P ps          # api   Up 8 seconds (healthy)
curl localhost:8000          # {"hitsInRedis":9,"visitsInPostgres":9,"servedBy":"ba783949fee2"}
curl localhost:8000/health   # {"status":"UP"}
```

**Système de fichiers en lecture seule :**

```bash
P exec api sh -c 'touch /app/pirate.txt; touch /etc/x; echo ok > /tmp/test && echo "/tmp: écriture OK"'
# touch: /app/pirate.txt: Read-only file system
# touch: /etc/x: Read-only file system
# /tmp: écriture OK
```

**Aucune capability**, même pour un processus **root** dans le conteneur :

```bash
P exec -u root api grep -E 'CapEff|CapBnd' /proc/self/status
# CapEff: 0000000000000000
# CapBnd: 0000000000000000
P exec -u root api chown node /app/package.json
# chown: /app/package.json: Read-only file system
docker run --rm --user root td4-api grep -E 'CapEff|CapBnd' /proc/self/status     # même image, sans durcissement
# CapEff: 00000000a80425fb
# CapBnd: 00000000a80425fb
```

L'API tourne déjà en `node` (non-root), donc son `CapEff` était déjà à 0. Le vrai gain de `cap_drop: ALL`, c'est
`CapBnd` (l'ensemble limite) à 0 : même un processus qui deviendrait root (faille, binaire setuid) ne pourrait
récupérer **aucune** capability.

**Limites :**

```bash
docker inspect td4-api-1 --format 'ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}} CapDrop={{.HostConfig.CapDrop}} Memory={{.HostConfig.Memory}} Tmpfs={{.HostConfig.Tmpfs}}'
# ReadonlyRootfs=true CapDrop=[ALL] Memory=268435456 Tmpfs=map[/tmp:]
docker stats --no-stream td4-api-1
# td4-api-1 37.46MiB / 256MiB
```

`268435456` octets = 256 Mio. Au-delà, l'OOM killer tue l'API (cgroups, cf. TD1-D4) au lieu de laisser saturer la
machine, et `unless-stopped` la relance.

**Pourquoi laisser `/tmp` inscriptible ?** Beaucoup de programmes et de bibliothèques ont besoin d'un endroit pour
des fichiers **temporaires** : upload en cours de traitement, fichiers de travail, sockets, caches. Avec tout le
système en lecture seule, ils planteraient. Un `tmpfs` est en mémoire, vidé à chaque redémarrage et limité au
conteneur : il ne permet ni de modifier l'application, ni de persister quoi que ce soit.

**Et les fichiers que l'app doit garder ?** Ni dans le conteneur, ni dans `/tmp`, qui disparaissent. Dans un
**volume nommé** monté sur un dossier dédié (par exemple `uploads:/app/uploads`, avec `UPLOAD_DIR` dans
l'environnement). En production cloud, dans un **stockage objet** (S3 ou équivalent), pour qu'ils soient partagés
entre plusieurs instances de l'API (12 facteurs, VI).

### B3 — Un scan qui bloque

```bash
trivy image --severity CRITICAL --exit-code 1 td4-api ; echo "code de sortie : $?"
# td4-api (alpine 3.24.2)   → 0 CRITICAL
# node-pkg (npm)            → 0 CRITICAL
# code de sortie : 0
```

**Code 0** : aucune faille CRITICAL, le scan laisse passer l'image.

Avec une dépendance vulnérable :

```bash
cd app && npm install --package-lock-only lodash@4.17.4 && cd ..
docker build --target prod -t td4-api app
trivy image --severity CRITICAL --exit-code 1 td4-api ; echo "code de sortie : $?"
# app/node_modules/lodash/package.json   node-pkg   1
# Total: 1 (CRITICAL: 1)
# │ lodash (package.json) │ CVE-2019-10744 │ CRITICAL │ fixed │ 4.17.4 │ 4.17.12 │ nodejs-lodash: prototype pollution in defaultsDeep function │
# code de sortie : 1
```

**Code 1** : Trivy trouve une faille CRITICAL (pollution de prototype dans `lodash` 4.17.4, corrigée en 4.17.12).
Grâce à `--exit-code 1`, la commande **échoue**, donc dans une CI l'étape est rouge et tout ce qui suit est annulé :
l'image vulnérable n'est jamais publiée. Sans `--exit-code 1`, Trivy afficherait le rapport mais renverrait 0, et la
pipeline continuerait.

Dépendance ensuite retirée : `package.json` et `package-lock.json` sont revenus à l'original, et le scan repasse à
code 0.

### B4 — La pipeline (GitHub Actions)

Le dépôt est sur GitHub : `.github/workflows/td4.yml` à la racine du dépôt. Un seul job (Docker est déjà installé
sur le runner), déclenché à chaque push et pull request qui touche `td4/` ou le workflow.

| Étape | Ce qu'elle fait |
|---|---|
| `build` | `docker build --target prod -t visites-api:ci td4/app`, avec les labels `org.opencontainers.image.source` et `.revision` (traçabilité, et lien du package GHCR avec le dépôt) |
| `scan` | Trivy 0.74.0, `--severity CRITICAL --exit-code 1` |
| `test` | réseau `ci`, Postgres (attente de `healthy`), Redis, puis l'API en `docker run` avec ses variables. Boucle jusqu'à 60 s sur `GET /`, qui doit contenir `visitsInPostgres`, sinon logs de l'API et échec |
| `publish` | uniquement sur un `push` vers la branche par défaut : `docker login ghcr.io` avec `GITHUB_TOKEN`, puis push de `ghcr.io/thomasfzr/visites-api:<sha court du commit>` |

Les étapes s'enchaînent : si l'une échoue, les suivantes sont sautées.

Le script de `test` a d'abord été rejoué en local (mêmes `docker run`) :
`{"hitsInRedis":2,"visitsInPostgres":2,…} -> ok=1`.

**Pipeline rouge.** Commit `fece4f7` poussé sur une branche de démonstration `td4-rouge`, avec `lodash@4.17.4`
(B3) : https://github.com/ThomasFzr/DevDockerM2/actions/runs/37588208466

```
job pipeline → failure
  build    → success
  scan     → failure     ← CVE-2019-10744 (CRITICAL), exit code 1
  test     → skipped
  publish  → skipped     ← l'image n'est PAS publiée
```

L'image n'est pas publiée : l'étape `scan` a échoué, donc `test` et `publish` n'ont jamais été exécutées.

La même chose s'est produite **sur `main`**, la branche où `publish` est censée tourner : le premier commit TD4
(`68d59dc`) contenait encore lodash.
https://github.com/ThomasFzr/DevDockerM2/actions/runs/37588853400

```
build → success · scan → failure · test → skipped · publish → skipped
```

Même sur la branche par défaut, une image vulnérable n'est pas publiée.

**Pipeline verte.** Commit `bde90e9` (lodash retiré) sur `main` :
https://github.com/ThomasFzr/DevDockerM2/actions/runs/37588967479

```
job pipeline → success
  build    → success
  scan     → success     ← 0 CRITICAL
  test     → success     ← l'API a répondu à GET / avec Postgres et Redis
  publish  → success     ← ghcr.io/thomasfzr/visites-api:bde90e9
```

### B5 — « Déployer »

L'image publiée est lisible sans authentification : le package GHCR est rattaché au dépôt public grâce au label
`org.opencontainers.image.source`. Pas besoin de `docker login` ici. Pour un dépôt privé, il faudrait
`docker login ghcr.io` avec un jeton personnel ayant le droit `read:packages`.

```bash
API_IMAGE=ghcr.io/thomasfzr/visites-api:bde90e9 docker compose -f compose.yaml -f compose.prod.yaml up -d --no-build
#  Image ghcr.io/thomasfzr/visites-api:bde90e9 Pulling     ← téléchargée, pas construite
P ps
# api     ghcr.io/thomasfzr/visites-api:bde90e9   Up 10 seconds (healthy)
# cache   redis:8-alpine                          Up 13 minutes (healthy)
# db      postgres:18-alpine                      Up 11 minutes (healthy)
docker image inspect ghcr.io/thomasfzr/visites-api:bde90e9 \
  --format '{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
# amd64 bde90e9b51520e6fce2575a9df18326321b8f1d7          ← construite par le runner, pour le commit bde90e9
curl localhost:8000
# {"hitsInRedis":11,"visitsInPostgres":11,"servedBy":"253f1a6cbe93"}   ← mêmes volumes : les données sont là
P exec api sh -c 'id -un; touch /app/x'
# node
# touch: /app/x: Read-only file system                    ← le durcissement de compose.prod.yaml s'applique
```

L'image est en `amd64` (runner GitHub) et mon Mac est en `arm64` : elle tourne quand même, grâce à l'émulation
fournie par OrbStack. C'est la situation de la slide « l'architecture compte », à l'envers : sur un vrai serveur
amd64, elle tournerait nativement.

Avec un tag qui n'existe pas, `--no-build` refuse de construire et la commande échoue. L'API déjà en place n'est
pas touchée :

```bash
API_IMAGE=ghcr.io/thomasfzr/visites-api:nexistepas P up -d --no-build api
# Error response from daemon: No such image: ghcr.io/thomasfzr/visites-api:nexistepas
```

**Pourquoi `--no-build` ?** Pour lancer **exactement** l'image construite, scannée et testée par la CI. Sans cette
option, Compose pourrait reconstruire l'image localement à partir de `build:` (présent dans `compose.yaml`). On
déploierait alors une image différente, jamais scannée ni testée, construite sur un autre poste, avec d'autres
dépendances résolues et une autre architecture : mon Mac produit de l'`arm64`, le runner de l'`amd64`. Avec
`--no-build`, si l'image n'est pas disponible, la commande échoue au lieu de construire en douce (vérifié
ci-dessus).

**Pourquoi un tag lié au commit plutôt que `latest` ?** `latest` **bouge** : il désigne l'image la plus récente au
moment du pull, et deux serveurs peuvent faire tourner deux versions différentes sous le même nom. Avec le SHA du
commit, le tag est **immuable et traçable** : on sait exactement quel code tourne en prod, on peut relire ce commit,
reproduire un bug, et revenir en arrière en relançant le tag précédent. C'est aussi le lien entre le dépôt, la
pipeline qui a validé ce commit et l'image déployée.
