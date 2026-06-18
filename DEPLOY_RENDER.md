# Deploy To Render (Official Public URL)

This project is ready for one-service deployment on Render.
The Node server serves both API and game page from the same origin.

## 1. Push To GitHub

1. Create a GitHub repository.
2. Push this folder contents.
3. Confirm these files exist in the repo root:
- `realtime-server.js`
- `beer_game.html`
- `package.json`
- `render.yaml`

## 2. Create Render Service From Blueprint

1. Sign in to Render.
2. Click `New +`.
3. Select `Blueprint`.
4. Connect your GitHub repo.
5. Render reads `render.yaml` and creates one web service.

## 3. Environment Settings

By default, `render.yaml` sets:
- `NODE_VERSION=20`
- `CORS_ORIGIN=*`

Optional:
- Set `REDIS_URL` if you want Redis-backed multi-instance realtime.

## 4. Deploy And Test

1. Wait for deployment to finish.
2. Open your service URL:
- `https://<your-service-name>.onrender.com/beer_game.html`
3. Verify health endpoint:
- `https://<your-service-name>.onrender.com/health`
4. Test with two devices/browsers joining same team.

## 5. Share With Players

Share only this URL:
- `https://<your-service-name>.onrender.com/beer_game.html`

No localhost, no extra port setup needed.

## 6. Classroom/Admin Notes

- Admin password default is `admin123` in code.
- Change it in `beer_game.html` before live use.
- Results are stored in browser local storage for each client session.

## 7. Optional: Custom Domain

In Render service settings:
1. `Settings` -> `Custom Domains`
2. Add your domain (e.g., `supplygame.yourschool.edu`)
3. Update DNS as instructed by Render.

## Quick Troubleshooting

- Build fails: ensure `package.json` has `start` script.
- Blank page: open `/beer_game.html` path explicitly.
- Realtime connection issues: check browser console and `/health` endpoint.
