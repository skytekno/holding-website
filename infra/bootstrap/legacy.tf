# The previous foundation defined Cloud SQL. The current database is externally
# managed. If an older version was applied, preserve those resources rather than
# deleting database data or its private network connection during this change.
# An operator must migrate data and explicitly decommission them separately.
removed {
  from = google_sql_database_instance.postgres
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_sql_database.cms
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_service_networking_connection.sql
  lifecycle {
    destroy = false
  }
}

removed {
  from = google_compute_global_address.sql_range
  lifecycle {
    destroy = false
  }
}
