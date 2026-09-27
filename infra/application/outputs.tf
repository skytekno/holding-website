output "dns_records" {
  description = "Create these A records at the authoritative DNS provider. Use DNS-only mode until the Google-managed certificate is ACTIVE."
  value       = { for host in concat(values(local.hosts), ["assets.skyhold.ing"]) : host => google_compute_global_address.https.address }
}
output "urls" {
  value = merge({ for key, host in local.hosts : key => "https://${host}" }, { assets = "https://assets.skyhold.ing" })
}
output "certificate_name" { value = google_compute_managed_ssl_certificate.https.name }
