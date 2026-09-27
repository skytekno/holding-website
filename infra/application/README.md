# Application edge infrastructure

Cloud Deploy owns the API, website and dashboard Cloud Run services, including their runtime configuration, scaling and revisions. This Terraform root owns their load-balancer invoker IAM bindings, serverless NEGs, HTTPS load balancer, certificate and CDN backends.

On the first deployment, deploy the three services successfully through Cloud Deploy **before** applying this root. Service names must be `${foundation.name}-api`, `${foundation.name}-web` and `${foundation.name}-dashboard` in the supplied project and region. The service manifests must restrict ingress to internal traffic and the load balancer. Applying this root then grants the load balancer unauthenticated invocation; the API continues to authorize all administrative requests.

Inputs are `project_id`, `region` and the non-secret `foundation` output (`name`, `assets_bucket`, `service_accounts`). Service images, authentication settings, database secret references and scaling belong to the Cloud Deploy manifests and release process.

The `removed` block in `services.tf` transfers management of services from an earlier Terraform state without destroying them. For an existing deployment, ensure Cloud Deploy targets the same service names, project and region; inspect the Terraform plan to confirm that the service resources are forgotten rather than destroyed. Keep the existing edge resource state.

The CDN caches only immutable website `/_next/static/*` resources and public file assets. HTML, React Server Component responses, the dashboard and API use uncached backends.

Follow the [deployment guide](../README.md) for the complete bootstrap, Cloud Deploy release, edge infrastructure and DNS/TLS sequence.
