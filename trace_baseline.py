import importlib.util, sys, traceback
spec = importlib.util.spec_from_file_location('bk', sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
try:
    m.derive_installed_mode(sys.argv[2])
except BaseException:
    traceback.print_exc()
