#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Provision Azure infrastructure for a self-hosted Supabase (production).
#
# This is a STARTING SCAFFOLD — review every value before running. It creates:
#   - a resource group
#   - an Ubuntu VM (Docker host for the Supabase stack) with a static public IP
#   - NSG rules for 80/443 (HTTP/HTTPS via Caddy) and 22 (SSH)
#   - (optional) Azure Database for PostgreSQL Flexible Server (managed DB)
#
# Requires: az CLI (logged in via `az login`). Nothing here is Al Barakah
# secret data — fill placeholders from your own tenant.
# ---------------------------------------------------------------------------
set -euo pipefail

# ---- Edit these ----
LOCATION="westeurope"
RG="albarakah-prod-rg"
VM_NAME="albarakah-supabase"
VM_SIZE="Standard_B2s"            # bump for production load
ADMIN_USER="azureuser"
DNS_LABEL="albarakah-supabase"    # -> ${DNS_LABEL}.${LOCATION}.cloudapp.azure.com
USE_MANAGED_POSTGRES="false"      # "true" to also create Azure Postgres
PG_SERVER="albarakah-pg"
PG_ADMIN="pgadmin"
# --------------------

echo "==> Resource group"
az group create --name "$RG" --location "$LOCATION" -o none

echo "==> Ubuntu VM (Docker host)"
az vm create \
  --resource-group "$RG" \
  --name "$VM_NAME" \
  --image "Ubuntu2204" \
  --size "$VM_SIZE" \
  --admin-username "$ADMIN_USER" \
  --generate-ssh-keys \
  --public-ip-address-dns-name "$DNS_LABEL" \
  --public-ip-sku Standard \
  -o none

echo "==> Open HTTP/HTTPS"
az vm open-port --resource-group "$RG" --name "$VM_NAME" --port 80 --priority 900 -o none
az vm open-port --resource-group "$RG" --name "$VM_NAME" --port 443 --priority 910 -o none

echo "==> Install Docker on the VM"
az vm run-command invoke \
  --resource-group "$RG" --name "$VM_NAME" \
  --command-id RunShellScript \
  --scripts "curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $ADMIN_USER" \
  -o none

if [ "$USE_MANAGED_POSTGRES" = "true" ]; then
  echo "==> Azure Database for PostgreSQL Flexible Server"
  read -rsp "Postgres admin password: " PG_PASS; echo
  az postgres flexible-server create \
    --resource-group "$RG" \
    --name "$PG_SERVER" \
    --location "$LOCATION" \
    --admin-user "$PG_ADMIN" \
    --admin-password "$PG_PASS" \
    --tier Burstable --sku-name Standard_B1ms \
    --version 15 --storage-size 32 \
    --public-access 0.0.0.0 \
    -o none
  echo "Managed Postgres host: ${PG_SERVER}.postgres.database.azure.com"
fi

echo
echo "Done. Next:"
echo "  1) SSH in:  ssh ${ADMIN_USER}@${DNS_LABEL}.${LOCATION}.cloudapp.azure.com"
echo "  2) Follow infra/azure/README.md to deploy the Supabase stack + Caddy."
