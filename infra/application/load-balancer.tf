resource "google_compute_global_address" "https" {
  name = "${var.foundation.name}-https"
}

resource "google_compute_region_network_endpoint_group" "application" {
  for_each              = local.hosts
  name                  = "${var.foundation.name}-${each.key}"
  network_endpoint_type = "SERVERLESS"
  region                = var.region
  cloud_run { service = "${var.foundation.name}-${each.key}" }
}

resource "google_compute_backend_service" "application" {
  for_each              = local.hosts
  name                  = "${var.foundation.name}-${each.key}"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  enable_cdn            = false
  backend { group = google_compute_region_network_endpoint_group.application[each.key].id }
  log_config {
    enable      = true
    sample_rate = 1
  }
}

# Static Next.js build artifacts are immutable. HTML/RSC responses use the uncached web backend.
resource "google_compute_backend_service" "web_static" {
  name                  = "${var.foundation.name}-web-static"
  protocol              = "HTTP"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  enable_cdn            = true
  backend { group = google_compute_region_network_endpoint_group.application["web"].id }
  cdn_policy {
    cache_mode        = "USE_ORIGIN_HEADERS"
    negative_caching  = false
    serve_while_stale = 0
    cache_key_policy {
      include_host         = true
      include_protocol     = true
      include_query_string = true
    }
  }
  log_config {
    enable      = true
    sample_rate = 0.1
  }
}

resource "google_compute_backend_bucket" "assets" {
  name        = "${var.foundation.name}-assets"
  bucket_name = var.foundation.assets_bucket
  enable_cdn  = true
  cdn_policy {
    cache_mode        = "USE_ORIGIN_HEADERS"
    negative_caching  = false
    serve_while_stale = 0
  }
  custom_response_headers = ["X-Content-Type-Options: nosniff"]
}

resource "google_compute_url_map" "https" {
  name            = var.foundation.name
  default_service = google_compute_backend_service.application["web"].id
  dynamic "host_rule" {
    for_each = local.hosts
    content {
      hosts        = [host_rule.value]
      path_matcher = host_rule.key
    }
  }
  host_rule {
    hosts        = ["assets.skyhold.ing"]
    path_matcher = "assets"
  }
  dynamic "path_matcher" {
    for_each = local.hosts
    content {
      name            = path_matcher.key
      default_service = google_compute_backend_service.application[path_matcher.key].id
      dynamic "path_rule" {
        for_each = path_matcher.key == "web" ? [1] : []
        content {
          paths   = ["/_next/static/*"]
          service = google_compute_backend_service.web_static.id
        }
      }
    }
  }
  path_matcher {
    name            = "assets"
    default_service = google_compute_backend_bucket.assets.id
  }
}

resource "google_compute_managed_ssl_certificate" "https" {
  name = "${var.foundation.name}-https"
  managed { domains = concat(values(local.hosts), ["assets.skyhold.ing"]) }
}

resource "google_compute_ssl_policy" "https" {
  name            = "${var.foundation.name}-tls"
  min_tls_version = "TLS_1_2"
  profile         = "MODERN"
}

resource "google_compute_target_https_proxy" "https" {
  name             = var.foundation.name
  url_map          = google_compute_url_map.https.id
  ssl_certificates = [google_compute_managed_ssl_certificate.https.id]
  ssl_policy       = google_compute_ssl_policy.https.id
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${var.foundation.name}-https"
  ip_address            = google_compute_global_address.https.id
  target                = google_compute_target_https_proxy.https.id
  port_range            = "443"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  network_tier          = "PREMIUM"
}

resource "google_compute_url_map" "redirect" {
  name = "${var.foundation.name}-http-redirect"
  default_url_redirect {
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  name    = "${var.foundation.name}-http-redirect"
  url_map = google_compute_url_map.redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "${var.foundation.name}-http"
  ip_address            = google_compute_global_address.https.id
  target                = google_compute_target_http_proxy.redirect.id
  port_range            = "80"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  network_tier          = "PREMIUM"
}
