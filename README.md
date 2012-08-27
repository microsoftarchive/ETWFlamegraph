# Prepare XPref ETL files for FlameGraph.

This node application parses a CSV file generated from an XPerf ETL file and produces a file that is ready to be consumed by flamegraph.pl.

See https://github.com/brendangregg/FlameGraph to get the flamegraph.pl and understand what a flame graph is.

The program can optionally also replace addresses in the stack frame with javascript symbols if the javascript compiler symbol information is in the CSV file.

## Example usage

To capture stack traces:
  xperf -on Latency -stackwalk profile
  run the scenario you want to profile.
  xperf -d perf.etl
  SET _NT_SYMBOL_PATH=srv*C:\symbols*http://msdl.microsoft.com/downloads/symbols
  xperf -i perf.etl -o perf.csv -symbols

To extract the stack for process x.exe and fold the stacks into perf.csv.fold.:
  node etlfold.js perf.csv x.exe

Then run the flamegraph script (requires perl) to generate the svg output.
  flamegraph.pl perf.csv.fold > perf.svg


If the node ETW events for javascript symbols are available then the procedure becomes the following.

First ensure that the built-in node ETW provider is registered. Use wevtutil ep to check for 'NodeJS-ETW-provider'.
If it is not available you may need to install a newer version of node. To manually register the manifest use 'wevtutil im node_etw_provider.man'

To capture stack traces:
  xperf -start symbols -on NodeJS-ETW-provider -f symbols.etl -BufferSize 128
  xperf -on Latency -stackwalk profile
  run the scenario you want to profile.
  xperf -d perf.etl
  xperf -stop symbols
  SET _NT_SYMBOL_PATH=srv*C:\symbols*http://msdl.microsoft.com/downloads/symbols
  xperf -merge perf.etl symbols.etl perfsym.etl
  xperf -i perfsym.etl -o perf.csv -symbols

The remaining steps are the same as in the previous example.


## CONTRIBUTING

The source is available at:

  https://github.com/MSOpenTech/ETWFlamegraph.git.

For issues, please use the Github issue tracker linked to the
repository. Github pull requests are very welcome. 


