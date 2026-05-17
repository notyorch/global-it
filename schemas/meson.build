schema_conf = configuration_data()
schema_conf.set('gschemadir', join_paths(get_option('datadir'), 'glib-2.0', 'schemas'))

install_data(
  'org.gnome.shell.extensions.global-it.gschema.xml',
  install_dir: schema_conf.get('gschemadir')
)
