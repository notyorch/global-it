project('global-it', 'c')

uuid = 'global-it@notyorch.github.io'
extdir = join_paths(get_option('datadir'), 'gnome-shell', 'extensions', uuid)

extension_files = files(
  'metadata.json',
  'extension.js',
  'panelMenu.js',
  'prefs.js',
  'README.md'
)

install_data(extension_files, install_dir: extdir)

install_subdir('dbus', install_dir: extdir)
install_subdir('adapters', install_dir: extdir)
install_subdir('utils', install_dir: extdir)

subdir('schemas')
