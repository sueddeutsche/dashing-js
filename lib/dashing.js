/*
    jscs:disable requireCamelCaseOrUpperCaseIdentifiers
 */
 "use strict";


var fs = require("fs");
var path = require("path");
var express = require("express");
var Mincer = require("mincer");
var logger = require("./logger");
var when = require("when");
require("coffee-script");

var DEBUG = true;


global.SCHEDULER = require("node-schedule");


function Dashing() {
    var dashing = {};
    dashing.root = path.resolve(process.cwd());
    dashing.NODE_ENV = process.env.NODE_ENV || "development";

    dashing.view_engine = process.env.VIEW_ENGINE || "jade";

    dashing.mincer = {};
    dashing.mincer.environment = new Mincer.Environment();
    dashing.mincer.assets_prefix = "/assets";
    dashing.mincer.environment.appendPath("assets/javascripts");
    dashing.mincer.environment.appendPath("assets/stylesheets");
    dashing.mincer.environment.appendPath("assets/fonts");
    dashing.mincer.environment.appendPath("assets/images");
    dashing.mincer.environment.appendPath("widgets");
    dashing.mincer.environment.appendPath(path.resolve(__dirname, "../javascripts"));

    dashing.public_folder = dashing.root + "/public";
    dashing.views = dashing.root + "/dashboards";
    dashing.default_dashboard = null;
    dashing.port = (process.env.PORT || 3030);

    dashing.protected = function (req, res, next) {
        next();
    };

    dashing._protected = function (req, res, next) {
        dashing.protected(req, res, next);
    };

    var expressLoggerOptions = {
        format: "dev",
        stream: {
            write: function (message, encoding) {
                logger.info(message);
            }
        }
    };

    // setup Express
    var app = express();
    app.configure("development", function () {
        Mincer.logger.use(logger);
    });
    app.configure("production", function () {
        expressLoggerOptions.format = "short";
        // In production we assume that assets are not changed between requests,
        // so we use cached version of environment.
        // All file system methods are cached for the instances lifetime.
        dashing.mincer.environment = dashing.mincer.environment.index;
    });
    app.configure(function () {
        app.set("views", dashing.views);
        app.set("view engine", dashing.view_engine);
        if (dashing.view_engine === "ejs") {
            app.use(require("express-ejs-layouts"));
        }
        app.use(express.logger(expressLoggerOptions));
        app.use(express.errorHandler());
        app.use(express.compress());
        app.use(express.json());
        app.use(express.urlencoded());
        app.use(express.methodOverride());
        app.use(dashing.mincer.assets_prefix, Mincer.createServer(dashing.mincer.environment));
        app.use(express.static(dashing.public_folder));
        app.use(app.router);
    });
    app.set("development", dashing.NODE_ENV === "development");
    app.set("production", dashing.NODE_ENV === "production");

    var connections = {};
    var history = {};

    app.get("/events", dashing._protected, function (req, res) {
        // let request last as long as possible
        req.socket.setTimeout(0);

        var conn = {
            id: (new Date().getTime().toString() + Math.floor(Math.random() * 1000).toString()),
            send: function (body) {
                res.write(body);
                res.flush(); // need to flush with .compress()
            }
        };
        connections[conn.id] = conn;

        // send headers for event-stream connection
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no" // Disable buffering for nginx
        });
        res.write("\n");
        res.write(Array(2049).join(" ") + "\n"); // 2kb padding for IE
        res.write(latest_events());
        res.flush(); // need to flush with .compress()

        req.on("close", function () {
            delete connections[conn.id];
        });
    });

    app.get("/", function (req, res, next) {
        if (dashing.default_dashboard) {
            res.redirect(dashing.default_dashboard);
        } else {
            first_dashboard(function (err, dashboard) {
                if (err) {
                    next(err);
                } else if (dashboard) {
                    res.redirect(dashboard);
                } else {
                    next(new Error("There are no dashboards in your dashboard directory."));
                }
            });
        }
    });

    app.get("/:dashboard", dashing._protected, function (req, res) {
        var dashboard = req.params.dashboard;
        fs.exists([dashing.views, dashboard + "." + dashing.view_engine].join(path.sep), function (exists) {
            if (exists) {
                res.render(dashboard, {
                    dashboard: dashboard,
                    request: req
                });
            } else {
                res.status(404).sendfile(dashing.public_folder + "/404.html");
            }
        });
    });

    app.get("/views/:widget?.html", dashing._protected, function (req, res) {
        var widget = req.params.widget;
        res.sendfile([dashing.root, "widgets", widget, widget + ".html"].join(path.sep));
    });

    app.post("/widgets/:id", function (req, res) {
        var auth_token = req.body.auth_token;
        if (!dashing.auth_token || dashing.auth_token == auth_token) {
            send_event(req.params.id, req.body);
            res.send(204);
        } else {
            res.send(401, "Invalid API key");
        }
    });

    // The 404 Route (ALWAYS Keep this as the last route)
    app.use(function (req, res, next) {
        res.status(404).sendfile(dashing.public_folder + "/404.html");
    });

    // Error handler
    app.use(function (err, req, res, next) {
        logger.error(err.stack);
        res.send(500, err);
    });

    function send_event(id, body) {
        body.id = id;
        body.updatedAt = Date.now();
        var event = format_event(body);
        history[id] = event;
        Object.keys(connections).forEach(function (k) {
            connections[k].send(event);
        });
    }
    global.send_event = send_event;

    function format_event(body) {
        return "data: " + JSON.stringify(body) + "\n\n";
    }

    function latest_events() {
        var str = [];
        Object.keys(history).forEach(function (id) {
            str.push(history[id]);
        });
        return str.join("");
    }

    function first_dashboard(fn) {
        fs.readdir(dashing.views, function (err, files) {
            if (err) {
                fn(err);
            }
            var regex = new RegExp("(\w*)\." + dashing.view_engine + "$");
            Object.keys(files).forEach(function (i) {
                var file = files[i];
                if (file.match(regex) && file !== "layout." + dashing.view_engine) {
                    fn(null, file.substring(0, file.length - (dashing.view_engine.length + 1)));
                    return;
                }
            });
            fn(null, null);
        });
    }

    // Load custom libraries
    fs.readdir([dashing.root, "lib"].join(path.sep), function (err, files) {
        if (err) {
            throw err;
        }
        Object.keys(files).forEach(function (i) {
            var file = [dashing.root, "lib", files[i]].join(path.sep);
            require(file);
        });
    });

    // Load jobs files
    loadRessourceJobs(process.env.JOB_PATH || path.join(dashing.root, "jobs"), logger);


    dashing.start = function () {
        app.listen(dashing.port);
        logger.info("Listening on http://0.0.0.0:" + dashing.port + (process.env.__daemon === "false" ? ", CTRL+C to stop" : ""));
    };

    dashing.app = app;
    return dashing;
}


function loadRessourceJobs(pathToJobs, logger) {
    return when.promise(function (resolve, reject) {

        DEBUG && console.log("Loading jobs from", pathToJobs, "...");

        fs.readdir(pathToJobs, function (err, files) {
            if (err) {
                console.error("Error loading jobs", err.message);
                reject(err);
            }

            var jobs = files.filter(function filterValidJobFiles(filename) {
                return filename.match(/(\w*)\.job\.(js|coffee)$/);
            });

            DEBUG && console.log("    jobs", JSON.stringify(jobs));

            jobs.forEach(function (filename) {

                var file = path.join(pathToJobs, filename);
                if (file.match(/(\w*)\.job\.(js|coffee)$/)) {
                    logger.log("Loading job file:", filename);

                    try {
                        require(file);
                        DEBUG && console.log("\tSuccess: job loaded", file);

                    } catch (e) {
                        console.log("\tError: failed loading job", e.message);
                    }
                }
            });

            resolve(jobs);
        });
    });
}


module.exports = Dashing;

