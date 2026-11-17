import importlib.util, sys, traceback
spec = importlib.util.spec_from_file_location('bld', sys.argv[1])
m = importlib.util.module_from_spec(spec)
sys.argv = [sys.argv[1]] + sys.argv[2:]
spec.loader.exec_module(m)
try:
    m.main()
except SystemExit:
    pass
except BaseException:
    traceback.print_exc()
