# Intelligent Session Store Microservice Example

Intelligent session stores are sessions that do more than just hold state submitted by a user. In this example code, you can see how to both generate and serve analytical data regarding a users session all encapsulated in a session storage microservice that uses Redis both as a transport and as a storage system.

## Setup

First, install as usual

```
$ npm install
```

You will need two terminal windows (or more). In one terminal, launch the web server:

```
$ node index.js --connection /path/to/your/json/node_redis/config.object.as.json
```

In the second window, launch the microservice:

```
$ node microservice.js --connection /path/to/your/json/node_redis/config.object.as.json
```

After both are running, you can go to [http://localhost:3379](http://localhost:3379).

## Next Steps

You can supply a `--sessionglob` argument to the microservice to split up the workload to multiple items based on the session ID


## License

Copyright 2018 Kyle J Davis

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
