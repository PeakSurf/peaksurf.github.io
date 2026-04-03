# PeakSurf Deploy Rollback

Current live-design backup tag:

- `backup-deploy-20260403-596086c`

Review the snapshot:

```bash
git fetch --tags peaksurf
git checkout backup-deploy-20260403-596086c
```

Reset local `main` to the saved snapshot:

```bash
git checkout main
git reset --hard backup-deploy-20260403-596086c
```
