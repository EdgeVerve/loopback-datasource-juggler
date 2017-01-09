/*!
 * Module exports class Model
 */
module.exports = DataAccessObject;

/*!
 * Module dependencies
 */
var async = require('async');
var jutil = require('./jutil');
var ValidationError = require('./validations').ValidationError;
var Relation = require('./relations.js');
var Inclusion = require('./include.js');
var List = require('./list.js');
var geo = require('./geo');
var Memory = require('./connectors/memory').Memory;
var utils = require('./utils');
var fieldsToArray = utils.fieldsToArray;
var removeUndefined = utils.removeUndefined;
var setScopeValuesFromWhere = utils.setScopeValuesFromWhere;
var idEquals = utils.idEquals;
var mergeQuery = utils.mergeQuery;
var util = require('util');
var assert = require('assert');
var BaseModel = require('./model');
var debug = require('debug')('loopback:dao');
var uuid = require('node-uuid');
var _ = require('lodash');

var checkOptions = true;
/**
 * Base class for all persistent objects.
 * Provides a common API to access any database connector.
 * This class describes only abstract behavior.  Refer to the specific connector for additional details.
 *
 * `DataAccessObject` mixes `Inclusion` classes methods.
 * @class DataAccessObject
 */
function DataAccessObject() {
    if (DataAccessObject._mixins) {
        var self = this;
        var args = arguments;
        DataAccessObject._mixins.forEach(function (m) {
            m.call(self, args);
        });
    }
}

function idName(m) {
    return m.definition.idName() || 'id';
}

function getIdValue(m, data) {
    return data && data[idName(m)];
}

function removeIdValue(m, data) {
    delete data[idName(m)];
    return data;
}
function setIdValue(m, data, value) {
    if (data) {
        data[idName(m)] = value;
    }
}

function byIdQuery(m, id) {
    var pk = idName(m);
    var query = { where: {} };
    query.where[pk] = id;
    return query;
}

function isWhereByGivenId(Model, where, idValue) {
    var arr = [];
    getKeys(where, arr);
    arr = _.uniq(arr);
    var keys = arr;//Object.keys(where);
    if (keys.length <= 0) //changed condition
        return false;

    var pk = idName(Model);
    if (keys.length == 1 && keys[0] !== pk) { return false; }//original condition
    //add lodash with version as dependency for this package else we need to check for functions
    else if (_.contains ? _.contains(keys, pk) : _.includes(keys, pk)) { return true; } //for ev case

    if (where[pk] === idValue) { return true; } //original condition
    else if (where.and && where.and[0][pk] === idValue) { return true; } //for ev case
    else //final
    { return false; }
}

DataAccessObject._forDB = function (data, dataSource) {
    if (!(dataSource.isRelational())) {
        return data;
    }

    var res = {};
    for (var propName in data) {
        var type = this.getPropertyType(propName);
        if (type === 'JSON' || type === 'Any' || type === 'Object' || data[propName] instanceof Array) {
            res[propName] = JSON.stringify(data[propName]);
        } else {
            res[propName] = data[propName];
        }
    }
    return res;
};

DataAccessObject.defaultScope = function (target, inst) {
    var scope = this.definition.settings.scope;
    if (typeof scope === 'function') {
        scope = this.definition.settings.scope.call(this, target, inst);
    }
    return scope;
};

DataAccessObject.applyScope = function (query, inst) {
    var scope = this.defaultScope(query, inst) || {};
    if (typeof scope === 'object') {
        mergeQuery(query, scope || {}, this.definition.settings.scope);
    }
};

DataAccessObject.applyProperties = function (data, inst) {
    var properties = this.definition.settings.properties;
    properties = properties || this.definition.settings.attributes;
    if (typeof properties === 'object') {
        util._extend(data, properties);
    } else if (typeof properties === 'function') {
        util._extend(data, properties.call(this, data, inst) || {});
    } else if (properties !== false) {
        var scope = this.defaultScope(data, inst) || {};
        if (typeof scope.where === 'object') {
            setScopeValuesFromWhere(data, scope.where, this);
        }
    }
};

DataAccessObject.lookupModel = function (data) {
    return this;
};

/**
 * Get the connector instance for the given model class
 * @returns {Connector} The connector instance
 */
DataAccessObject.getConnector = function (options) {
    return this.getDataSource(options).connector;
};

// Empty callback function
function noCallback(err, result) {
    // NOOP
    debug('callback is ignored: err=%j, result=%j', err, result);
}

/// Atul : applyRecord() will check the status of the record and actually call model's method to do create/update/delete operation on model.
/// it will put id field (pk) in where clause for update and delete operation.
// model - model object
// pk - primarky keys of model
// options - whatever is passed - mostly to do with begin/end transaction
// r - actual record to create/delete/update
// cb - callback
function applyRecord(modelParameter, pk, options, r, cb) {
    if (modelParameter.getOverridenModel) {
        modelParameter.getOverridenModel(options, function (err, model) {
            applyRecordInner(model, pk, options, r, cb);
        });
    } else {
        applyRecordInner(modelParameter, pk, options, r, cb);
    }

    function applyRecordInner(model, pk, options, r, cb) {
        var rowStatus = r.__row_status;
        delete r.__row_status;

        if (rowStatus == 'added') {
            model.create(r, options, function (err, instance) {
                cb(err, instance);
            });
        } else if (rowStatus == 'modified' || rowStatus == 'deleted') {
            if (pk.length > 0) {
                var w = []; //where clause
                for (var j = 0; j < pk.length; ++j) {
                    var x = Object.keys(pk[j])[0];
                    var o = {};
                    o[x] = r[x];
                    //w[x] = r[x];
                    w.push(o);
                }
                if (rowStatus == 'modified') {
                    model.upsert(r, options, function (err, instance) {
                        cb(err, { __data: instance.__data }); //instance);cb(err, instance);
                    });
                } else { // if transaction is deleted
                    var whereClause = { and: w };
                    if (w.length == 1) {
                        whereClause = w[0];
                    }
                    model.destroyAll(whereClause, options, function (err, instance) {
                        cb(err, instance);
                    });
                }
            } else {
                if (rowStatus == 'modified') {
                    model.updateAttributes(r, options, function (err, instance) {
                        cb(err, instance);
                    });
                }
            }
        } else {
            return cb();
        }
    }
}



/// Atul : this function returns a list of id fields of model.
/// we can use idNames() also. but i kept it for a while. once tested, it can be removed and better method can be used.
// TODO : use of idNames().
function getIdFields(model) {

    var flagIdField = false;
    var pk = [];

    if (typeof model === 'string') {
        model = loopback.getModel(model);
    }

    var pkNames = model.definition.idNames();
    for (var p in model.definition.properties) {
        var property = model.definition.properties[p];

        if (p === 'id') {
            flagIdField = true;
        }

        if (property.id) {
            var x = {};
            x[p] = property;
            pk.push(x);
        }
    }
    if (pk.length == 0) {
        if (!flagIdField)
            return pk;
        else
            return [{ id: model.definition.properties['id'] }];
    }
    return pk;
}

/// Atul : This is helper function to retrieve child relations. so far hasMany and hasOne being retrieved
// TODO : Is there any better way of getting relations?
function getChildRelations(model) {

    var relations = {};

    for (var r in model.relations) {
        if (model.relations[r].type === 'hasMany' || model.relations[r].type === 'hasOne') {
            relations[r] = model.relations[r].modelTo.modelName;
        }
    }
    return relations;
}


// Atul : compositePost() will take entire composite model data and execute against database
// Data should be form as below for composite model Customer, CustomerAddress and Country. you can post customer and customerAddress in nested structure
// Every record should have status field indicating what to do with the record.
//var x =
//{
//    "Customer" : [
//        {
//            "id" : 1,
//            "name" : "Smith",
//            "age" : 30,
//            "__row_status" : "added"
//        },
//        {
//            "id" : 3,
//            "name" : "Smith",
//            "age" : 31,
//            "customerAddress" : [
//                {
//                    "id" : 11,
//                    "line1" : "12, Mountain Ave",
//                    "city" : "Fremont",
//                    "state" : "CA",
//                    "__row_status" : "added"
//                },
//                {
//                    "id" : 11,
//                    "line1" : "44, Mountain Ave",
//                    "city" : "Fremont",
//                    "state" : "CA",
//                    "__row_status" : "added"
//                }
//                ],
//            "__row_status" : "added"
//        },
//        {
//            "id" : 3,
//            "age" : 35,
//            "__row_status" : "udpated"
//        }
//    ],
//    "Country" : [
//        {
//            "id" : 1,
//            "code" : "ind",
//            "name" : "India",
//            "__row_status" : "added"
//        },
//        {
//            "id" : 2,
//            "code" : "us",
//            "name" : "United States",
//            "__row_status" : "added"
//        }
//    ]
//};

function compositePostInner(self, data, options, cb) {
    var uow = data.Uow || data.uow || data;
    var responseData = {};

    async.forEachOfSeries(uow, function (rows, m, done) {
        if (!self.settings.compositeModels[m]) {
            debug('Warning : ' + m + ' model is not part of composite model : ');
            return done();
        }
        var model = self.dataSource.modelBuilder.models[m]; //loopback.getModel(m);
        var pk = getIdFields(model);
        var relations = getChildRelations(model);

        async.eachSeries(rows, function (r, done2) {
            var childData = {};
            for (var relName in relations) {
                childData[relName] = r[relName];
                delete r[relName];
            }
            applyRecord(model, pk, options, r, function (err, createdRecord) {
                if (err) {
                    return done2(err);
                }
                if (!createdRecord)
                    return done2();
                if (!responseData[m]) {
                    responseData[m] = [];
                }
                responseData[m].push(createdRecord.__data);
                async.forEachOfSeries(childData, function (childRows, relationName, done3) {
                    if (!childRows) {
                        return done3();
                    }
                    var relatedModel = relations[relationName];
                    var childModel = self.dataSource.modelBuilder.models[relatedModel]; //loopback.getModel(relatedModel);
                    var pk2 = getIdFields(childModel);
                    var keyTo = model.relations[relationName].keyTo;
                    var keyFrom = model.relations[relationName].keyFrom;
                    async.eachSeries(childRows, function (cr, done4) {
                        cr[keyTo] = createdRecord[keyFrom];
                        applyRecord(childModel, pk2, options, cr, function (err2, createdRecord2) {
                            if (err2) {
                                return done4(err2);
                            }
                            if (!createdRecord2)
                                return done4();
                            var len = responseData[m].length - 1;
                            var parentResponseRecord = responseData[m][len];
                            if (!parentResponseRecord[relationName]) {
                                parentResponseRecord[relationName] = [];
                            }
                            parentResponseRecord[relationName].push(createdRecord2.__data);
                            done4(err2);
                        });
                    },
                        function (err5) {
                            done3(err5);
                        });
                },
                    function (err4) {
                        done2(err4);
                    }
                );
            });
        }, function (err) {
            debug('Error while creating record for composite model ', err);
            done(err);
        });
    },
        function (err2) {
            debug('Error while creating record for composite model ', err2);
            if (err2)
                return cb(err2, null);
            return cb(null, responseData);
        });
}

function compositePost(self, data, options, cb) {

    if (typeof self.settings.CompositeTransaction == 'undefined')
        self.settings.CompositeTransaction = true;
    if (self.settings.CompositeTransaction && !options.transaction) {
        self.beginTransaction({ isolationLevel: self.Transaction.READ_COMMITTED }, function (err, tx) {
            options.transaction = tx;
            compositePostInner(self, data, options, function (err, responseData) {
                if (err) {
                    tx.rollback();
                    return cb(err, null);
                }
                tx.commit(function (cerr) {
                    return cb(cerr, responseData);
                });
            });
        });
    } else {
        compositePostInner(self, data, options, cb);
    }
}

// Atul : compositeGet() method retreive all the composite model data
// data format is very similar to what is shown above in postModel()
function compositeGet(self, query, options, cb) {

    var data = query;
    var resultSet = {};

    var included = [];

    async.forEachOfSeries(self.settings.compositeModels, function (m, modelName, done) {

        if (included.indexOf(modelName) >= 0) {
            return done();
        }

        var model = self.dataSource.modelBuilder.models[modelName]; //loopback.getModel(modelName);
        var relations = getChildRelations(model);

        if (!data)
            data = {};
        if (!data[modelName])
            data[modelName] = {};

        for (var r in relations) {
            if (!data[modelName].include)
                data[modelName].include = [];
            if (self.settings.compositeModels[relations[r]]) {
                data[modelName].include.push(r);
                included.push(relations[r]);
            }
        }

        if (model.getOverridenModel) {
            model.getOverridenModel(options, function (err, model2) {
                model2.find(data[modelName], function (err, result) {
                    resultSet[modelName] = result;
                    done(err);
                });
            });
        } else {
            model.find(data[modelName], function (err, result) {
                resultSet[modelName] = result;
                done(err);
            });
        }
    },
        function (err) {
            if (err)
                return cb(err);
            cb(null, resultSet);
        });
}

//Atul : Perform implicit composite
function implicitComposite(self, data, childData, relations, options, cb) {
    //var responseData = {};
    //var m = self.modelName;
    var deleteRelations = [];

    function createModelChildData(self, data, childData, relations, options, deleteRelations, cb) {
        var responseData = {};
        //var m = self.modelName;

        for (var r in deleteRelations) {
            delete childData[r];
            delete relations[r];
        }

        function createChildModelRecordInner(childModel2, cr, options, done4, relationName) {
            childModel2.create(cr, options, function (err3, createdRecord2) {
                if (err3) {
                    return done4(err3);
                }

                if (!createdRecord2) {
                    return done4();
                }

                if (!responseData[relationName]) {
                    responseData[relationName] = [];
                }
                responseData[relationName].push(createdRecord2.__data);
                done4(err3);
            });
        }

        self.create(data, options, function (err, createdRecord) {
            if (err) {
                return cb(err, createdRecord);
            }
            responseData = createdRecord.__data;
            async.forEachOfSeries(childData, function (childRows, relationName, done3) {
                var relatedModel = relations[relationName];
                var childModel = self.dataSource.modelBuilder.models[relatedModel];
                var keyTo = self.relations[relationName].keyTo;
                var keyFrom = self.relations[relationName].keyFrom;
                async.eachSeries(childRows, function (cr, done4) {
                    cr[keyTo] = createdRecord[keyFrom];
                    if (childModel.getOverridenModel) {
                        childModel.getOverridenModel(options, function (err, childModel2) {
                            createChildModelRecordInner(childModel2, cr, options, done4, relationName);
                        });
                    } else {
                        createChildModelRecordInner(childModel, cr, options, done4, relationName);
                    }
                },
                function (err) {
                    return done3(err);
                });
            },
            function (err) {
                return cb(err, responseData);
            });
        });
    }

    async.forEachOfSeries(childData, function (childRows, relationName, doneBTo) {
        if (self.relations[relationName].type === 'belongsTo') {
            var relatedModel = relations[relationName];
            var childModel = self.dataSource.modelBuilder.models[relatedModel];
            var keyTo = self.relations[relationName].keyTo;
            var keyFrom = self.relations[relationName].keyFrom;
            options[relationName] = childRows;

            // Add for multiple and also for put and get as is possible

            // Making object into an array
            if (Array.isArray(childRows)) {
                async.eachSeries(childRows, function (cr, doneChildBTo) {
                    childModel.create(cr, options, function(err, createdRecord) {
                        if(err) {
                            return cb(err);
                        }
                        childModelData = createdRecord.__data;
                        if (!data[keyFrom]) {
                            data[keyFrom] = [];
                        }
                        data[keyFrom].push(childModelData[keyTo]);
                        doneChildBTo(err);
                    });
                }, function (err) {
                    if (!err) {
                        deleteRelations.push(relationName);
                    }
                    return doneBTo(err);
                });
            } else {
                childModel.create(childRows, options, function(err, createdRecord) {
                    if(err) {
                        return cb(err);
                    }
                    childModelData = createdRecord.__data;
                    data[keyFrom] = childModelData[keyTo];
                    deleteRelations.push(relationName);
                    return doneBTo(err);
                });
            }
        } else {
            return doneBTo();
        }
    }, function (err) {
        if (err) {
            cb(err);
        } else {
            createModelChildData(self, data, childData, relations, options, deleteRelations, cb);
        }
    });

    //createModelChildData(self, data, childData,relations, options, cb);
}


/**
 * Create an instance of Model with given data and save to the attached data source. Callback is optional.
 * Example:
 *```js
 * User.create({first: 'Joe', last: 'Bob'}, function(err, user) {
 *  console.log(user instanceof User); // true
 * });
 * ```
 * Note: You must include a callback and use the created model provided in the callback if your code depends on your model being
 * saved or having an ID.
 *
 * @param {Object} [data] Optional data object
 * @param {Object} [options] Options for create
 * @param {Function} [cb]  Callback function called with these arguments:
 *   - err (null or Error)
 *   - instance (null or Model)
 */
DataAccessObject.create = function (data, options, cb) {
    var dataSource = this.getDataSource(options);
    var connectionPromise = stillConnecting(dataSource, this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    var Model = this;
    var connector = dataSource.connector;
    assert(typeof connector.create === 'function',
        'create() must be implemented by the connector');

    var self = this;

    if (options === undefined && cb === undefined) {
        if (typeof data === 'function') {
            // create(cb)
            cb = data;
            data = {};
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            // create(data, cb);
            cb = options;
            options = {};
        }
    }

    data = data || {};
    options = options || {};
    cb = cb || (Array.isArray(data) ? noCallback : utils.createPromiseCallback());

    if (checkOptions && Object.getOwnPropertyNames(options).length === 0) {
        console.trace('options is not being passed');
        process.exit(1);
    }

    assert(typeof data === 'object', 'The data argument must be an object or array');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    var hookState = {};
    var settings = self.definition.settings;
    // Atul : If compositeModel is being posted.. call compositePost() helper
    if (settings.compositeModels) {
        compositePost(self, data, options, cb);
        return data;
    }

    //Atul : relation is object that fetches all child relation of model for which data is being posted.
    var relations = {};
    for (var r in self.relations) {
        if (self.relations[r].type === 'hasMany' || self.relations[r].type === 'hasOne' || self.relations[r].type === 'belongsTo') {
            relations[r] = self.relations[r].modelTo.modelName;
        }
    }
    // Atul : childData holds nested related data of model. only one level nesting is supported
    var childData = false;
    for (var relName in relations) {
        if (!data[relName])
            continue;
        if (typeof data[relName] == 'function')
            continue;
        if (!childData)
            childData = {};
        childData[relName] = data[relName];
        delete data[relName];
    }

    // Atul : if nested data exist, fall in to this if and create records recursively for nested child
    if (childData) {
        var m = self.modelName;
        if (!options.transaction) {
            self.beginTransaction({ isolationLevel: self.Transaction.READ_COMMITTED }, function (err, tx) {
                options.transaction = tx;
                implicitComposite(self, data, childData, relations, options, function (err, responseData) {
                    if (err) {
                        tx.rollback(function (cerr) {
                            return cb(err || cerr, null);
                        });
                        return;
                    }
                    tx.commit(function (cerr) {
                        return cb(cerr, responseData);
                    });
                });
            });
        } else {
            implicitComposite(self, data, childData, relations, options, cb);
        }
        return data;
    }


    if (Array.isArray(data)) {
        // Undefined item will be skipped by async.map() which internally uses
        // Array.prototype.map(). The following loop makes sure all items are
        // iterated
        for (var i = 0, n = data.length; i < n; i++) {
            if (data[i] === undefined) {
                data[i] = {};
            }
        }
        async.map(data, function (item, done) {
            self.create(item, options, function (err, result) {
                // Collect all errors and results
                done(null, { err: err, result: result || item });
            });
        }, function (err, results) {
            if (err) {
                return cb(err, results);
            }
            // Convert the results into two arrays
            var errors = null;
            var data = [];
            for (var i = 0, n = results.length; i < n; i++) {
                if (results[i].err) {
                    if (!errors) {
                        errors = [];
                    }
                    errors[i] = results[i].err;
                }
                data[i] = results[i].result;
            }
            cb(errors, data);
        });
        return data;
    }

    var enforced = {};
    var obj;
    var idValue = getIdValue(this, data);

    // if we come from save
    if (data instanceof Model && !idValue) {
        obj = data;
    } else {
        obj = new Model(data);
    }

    this.applyProperties(enforced, obj);
    obj.setAttributes(enforced);

    Model = this.lookupModel(data); // data-specific
    if (Model !== obj.constructor) obj = new Model(data);

    var context = {
        Model: Model,
        instance: obj,
        isNewInstance: true,
        hookState: hookState,
        options: options
    };
    Model.notifyObserversOf('before save', context, function (err) {
        if (err) return cb(err);

        data = obj.toObject(true);

        // validation required
        obj.isValid(function (valid) {
            if (valid) {
                create();
            } else {
                cb(new ValidationError(obj), obj);
            }
        }, options, data);
    });

    function create() {
        obj.trigger('create', function (createDone) {
            obj.trigger('save', function (saveDone) {
                var _idName = idName(Model);
                var modelName = Model.modelName;
                var val = removeUndefined(obj.toObject(true));
                function createCallback(err, id, rev) {
                    if (id) {
                        obj.__data[_idName] = id;
                        defineReadonlyProp(obj, _idName, id);
                    }
                    if (rev) {
                        obj._rev = rev;
                    }
                    if (err) {
                        return cb(err, obj);
                    }
                    obj.__persisted = true;

                    var context = {
                        Model: Model,
                        data: val,
                        isNewInstance: true,
                        hookState: hookState,
                        options: options
                    };
                    Model.notifyObserversOf('loaded', context, function (err) {
                        if (err) return cb(err);

                        // By default, the instance passed to create callback is NOT updated
                        // with the changes made through persist/loaded hooks. To preserve
                        // backwards compatibility, we introduced a new setting updateOnLoad,
                        // which if set, will apply these changes to the model instance too.
                        if (Model.settings.updateOnLoad) {
                            obj.setAttributes(context.data);
                        }
                        saveDone.call(obj, function () {
                            createDone.call(obj, function () {
                                if (err) {
                                    return cb(err, obj);
                                }
                                var context = {
                                    Model: Model,
                                    instance: obj,
                                    isNewInstance: true,
                                    hookState: hookState,
                                    options: options
                                };

                                Model.notifyObserversOf('after save', context, function (err) {
                                    cb(err, obj);
                                    if (!err) Model.emit('changed', obj);
                                });
                            });
                        });
                    });
                }

                context = {
                    Model: Model,
                    data: val,
                    isNewInstance: true,
                    currentInstance: obj,
                    hookState: hookState,
                    options: options
                };
                Model.notifyObserversOf('persist', context, function (err) {
                    if (err) return cb(err);
                    /**
                     * Dipayan: check for transaction object
                     */
                    if (options && options.transaction && options.transaction.connection) {
                        //data.__db_status = 'insertPending';
                        //data.__db_transaction_id = options.transaction.connection.transactionId;
                        var opData = {};
                        opData.model = Model.modelName;
                        opData.op = 'create';
                        opData.filter = {};
                        opData.datasource = Model.dataSource.settings.database;
                        opData.connector = dataSource.connector;
                        var _idName = idName(Model);
                        var __data = obj.constructor._forDB(context.data, dataSource);
                        __data[_idName] = __data[_idName] || uuid.v4(); //if no id passed, setting an unique id
                        opData.data = __data;
                        if (!options.transaction.connection.opData)
                            options.transaction.connection.opData = [];
                        options.transaction.connection.opData.push(opData);
                        return createCallback(null, __data[_idName]);
                    } else {
                        if (connector.create.length === 4) {
                            connector.create(modelName, obj.constructor._forDB(context.data, dataSource), options, createCallback);
                        } else {
                            connector.create(modelName, obj.constructor._forDB(context.data, dataSource), createCallback);
                        }
                    }
                });
            }, obj, cb);
        }, obj, cb);
    }

    // Does this make any sense? How would chaining be used here? -partap

    // for chaining
    return cb.promise || obj;
};

function stillConnecting(dataSource, obj, args) {
    if (typeof args[args.length - 1] === 'function') {
        return dataSource.ready(obj, args);
    }

    // promise variant
    var promiseArgs = Array.prototype.slice.call(args);
    promiseArgs.callee = args.callee;
    var cb = utils.createPromiseCallback();
    promiseArgs.push(cb);
    if (dataSource.ready(obj, promiseArgs)) {
        return cb.promise;
    } else {
        return false;
    }
}


function implicitPut(self, data, childData, relations, options, cb) {
    var deleteRelations = [];

    function createOrUpdateModelChildData(self, data, childData, relations, options, deleteRelations, cb) {
        //var m = self.modelName;
        var responseData = {};

        for (var r in deleteRelations) {
            delete childData[r];
            delete relations[r];
        }

        self.updateOrCreate(data, options, function (err, createdRecord) {
            if (err) {
                return cb(err, createdRecord);
            }
            responseData = createdRecord.__data;
            async.forEachOfSeries(childData, function (childRows, relationName, done3) {
                var relatedModel = relations[relationName];
                var childModel = self.dataSource.modelBuilder.models[relatedModel];
                var keyTo = self.relations[relationName].keyTo;
                var keyFrom = self.relations[relationName].keyFrom;
                var pk2 = getIdFields(childModel);

                async.eachSeries(childRows, function (cr, done4) {
                    cr[keyTo] = createdRecord[keyFrom];
                    applyRecord(childModel, pk2, options, cr, function (err3, createdRecord2) {
                        //childModel.create(cr, options, function (err3, createdRecord2) {
                        if (err3)
                            return done4(err3);
                        if (!createdRecord2)
                            return done4();

                        if (!responseData[relationName]) {
                            responseData[relationName] = [];
                        }
                        responseData[relationName].push(createdRecord2.__data);
                        done4(err3);
                    });
                },
                function (err) {
                    return done3(err);
                });
            },
            function (err) {
                cb(err, responseData);
            });
        });
    }

    async.forEachOfSeries(childData, function (childRows, relationName, doneBTo) {
        if (self.relations[relationName].type === 'belongsTo') {
            var relatedModel = relations[relationName];
            var childModel = self.dataSource.modelBuilder.models[relatedModel];
            var keyTo = self.relations[relationName].keyTo;
            var keyFrom = self.relations[relationName].keyFrom;
            options[relationName] = childRows;

            // Checking if object or array
            if (Array.isArray(childRows)) {
                async.eachSeries(childRows, function (cr, doneChildBTo) {
                    childModel.updateOrCreate(cr, options, function (err, createdRecord) {
                        if (err) {
                            return cb(err);
                        }
                        childModelData = createdRecord.__data;
                        if (!data[keyFrom]) {
                            data[keyFrom] = [];
                        }
                        data[keyFrom].push(childModelData[keyTo]);
                        doneChildBTo(err);
                    });
                }, function (err) {
                    if (!err) {
                        deleteRelations.push(relationName);
                    }
                    return doneBTo(err);
                });
            } else {
                childModel.updateOrCreate(childRows, options, function (err, createdRecord) {
                    if (err) {
                        return cb(err);
                    }
                    childModelData = createdRecord.__data;
                    data[keyFrom] = childModelData[keyTo];
                    deleteRelations.push(relationName);
                    return doneBTo(err);
                });
            }
        } else {
            return doneBTo();
        }
    }, function (err) {
        if (err) {
            cb(err);
        } else {
            createOrUpdateModelChildData(self, data, childData, relations, options, deleteRelations, cb);
        }
    });
}

/**
 * Update or insert a model instance: update exiting record if one is found, such that parameter `data.id` matches `id` of model instance;
 * otherwise, insert a new record.
 *
 * NOTE: No setters, validations, or hooks are applied when using upsert.
 * `updateOrCreate` is an alias
 * @param {Object} data The model instance data
 * @param {Object} [options] Options for upsert
 * @param {Function} cb The callback function (optional).
 */
// [FIXME] rfeng: This is a hack to set up 'upsert' first so that
// 'upsert' will be used as the name for strong-remoting to keep it backward
// compatible for angular SDK
DataAccessObject.updateOrCreate = DataAccessObject.upsert = function upsert(data, options, cb) {
    var dataSource = this.getDataSource(options);
    var connectionPromise = stillConnecting(dataSource, this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    if (options === undefined && cb === undefined) {
        if (typeof data === 'function') {
            // upsert(cb)
            cb = data;
            data = {};
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            // upsert(data, cb)
            cb = options;
            options = {};
        }
    }

    cb = cb || utils.createPromiseCallback();
    data = data || {};
    options = options || {};

    if (checkOptions && Object.getOwnPropertyNames(options).length === 0) {
        console.trace('options is not being passed');
        process.exit(1);
    }

    assert(typeof data === 'object', 'The data argument must be an object');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    var hookState = {};

    var self = this;
    var Model = this;
    var connector = dataSource.connector;

    //Atul : relation is object that fetches all child relation of model for which data is being posted.
    var relations = {};
    for (var r in self.relations) {
        if (self.relations[r].type === 'hasMany' || self.relations[r].type === 'hasOne' || self.relations[r].type === 'belongsTo') {
            relations[r] = self.relations[r].modelTo.modelName;
        }
    }
    // Atul : childData holds nested related data of model. only one level nesting is supported
    var childData = false;
    for (var relName in relations) {
        if (!data[relName])
            continue;
        if (typeof data[relName] == 'function')
            continue;
        if (!childData)
            childData = {};
        childData[relName] = data[relName];
        delete data[relName];
    }


    // Atul : if nested data exist, fall in to this if and create records recursively for nested child
    if (childData) {
        if (!options.transaction) {
            self.beginTransaction({ isolationLevel: self.Transaction.READ_COMMITTED }, function (err, tx) {
                options.transaction = tx;
                implicitPut(self, data, childData, relations, options, function (err, responseData) {
                    if (err) {
                        tx.rollback(function (cerr) {
                            return cb(err || cerr, null);
                        });
                        return;
                    }
                    tx.commit(function (cerr) {
                        return cb(cerr, responseData);
                    });
                });
            });
        } else {
            implicitPut(self, data, childData, relations, options, cb);
        }
        return cb.promise;
    }

    if (Array.isArray(data)) {
        // Undefined item will be skipped by async.map() which internally uses
        // Array.prototype.map(). The following loop makes sure all items are
        // iterated
        for (var i = 0, n = data.length; i < n; i++) {
            if (data[i] === undefined) {
                data[i] = {};
            }
        }
        async.map(data, function (item, done) {
            var id = getIdValue(self, item);
            if (id === undefined || id === null) {
                self.create(item, options, function (err, result) {
                    // Collect all errors and results
                    done(null, { err: err, result: result || item });
                });
            } else {
                self.updateOrCreate(item, options, function (err, result) {
                    // Collect all errors and results
                    done(null, { err: err, result: result || item });
                });
            }
        }, function (err, results) {
            if (err) {
                return cb(err, results);
            }
            // Convert the results into two arrays
            var errors = null;
            var data = [];
            for (var i = 0, n = results.length; i < n; i++) {
                if (results[i].err) {
                    if (!errors) {
                        errors = [];
                    }
                    errors[i] = results[i].err;
                }
                data[i] = results[i].result;
            }
            cb(errors, data);
        });
        return data;
    }

    var id = getIdValue(this, data);
    if (id === undefined || id === null) {
        return this.create(data, options, cb);
    }
    var context = {
        Model: Model,
        query: byIdQuery(Model, id),
        hookState: hookState,
        options: options
    };
    var mixins = Model.definition.settings.mixins;
    if (mixins && mixins.DataPersonalizationMixin) {
        var idQuery = { 'where': context.query.where };
        var valArray = [];
        if (data.scope && !(_.isEmpty(data.scope))) {
            var scope = data.scope.__data || data.scope;
            _.forEach(scope, function (value, key) {
                var cond = {};
                cond['scope.' + key] = value;
                valArray.push(cond);
            });
            var dpQuery = {
                'where': {
                    'and': valArray
                }
            };
            mergeQuery(idQuery, dpQuery);
        }
        //checking if a record is available for the id with same context.
        Model.findOne(idQuery, options, function (err, origdata) {
            if (origdata) {
                if (mixins && mixins.EvVersionMixin) {
                    if (origdata._version === data._version) {
                        Model.notifyObserversOf('access', context, doUpdateOrCreate);
                    } else {
                        return cb(new Error('No record found with current version'));
                    }
                } else if (data.scope && !(_.isEqual(data.scope, origdata.scope))) {

                    if (Model.definition.settings.idInjection)
                        removeIdValue(Model, data);

                    return self.create(data, options, cb);
                } else {
                    Model.notifyObserversOf('access', context, doUpdateOrCreate);
                }
            } else {
                //there is no record with matching id.
                //remove id if idinjection is set to true.
                if (Model.definition.settings.idInjection)
                    removeIdValue(Model, data);
                //create a new record
                return self.create(data, options, cb);
            }
        });
    } else {
        //THE ORIGINAl FLOW
        Model.notifyObserversOf('access', context, doUpdateOrCreate);
    }

    function doUpdateOrCreate(err, ctx) {
        if (err) return cb(err);

        var isOriginalQuery = isWhereByGivenId(Model, ctx.query.where, id);
        if (connector.updateOrCreate && isOriginalQuery) {
            var context = {
                Model: Model,
                where: ctx.query.where,
                data: data,
                hookState: hookState,
                options: options
            };
            Model.notifyObserversOf('before save', context, function (err, ctx) {
                if (err) return cb(err);
                if (!ctx.data && ctx.instanceUpdated) {
                    return cb(null, ctx.updatedInstance);
                }

                data = ctx.data;
                var update = data;
                var inst = data;
                if (!(data instanceof Model)) {
                    inst = new Model(data, { applyDefaultValues: false });
                }
                update = inst.toObject(false);

                Model.applyProperties(update, inst);
                Model = Model.lookupModel(update);

                var connector = dataSource.connector;

                if (Model.settings.validateUpsert === false) {
                    callConnector();
                } else {
                    inst.isValid(function (valid) {
                        if (!valid) {
                            if (Model.settings.validateUpsert) {
                                return cb(new ValidationError(inst), inst);
                            } else {
                                // TODO(bajtos) Remove validateUpsert:undefined in v3.0
                                console.warn('Ignoring validation errors in updateOrCreate():');
                                console.warn('  %s', new ValidationError(inst).message);
                                // continue with updateOrCreate
                            }
                        }
                        callConnector();
                    }, options, update);
                }

                function callConnector() {
                    update = removeUndefined(update);
                    context = {
                        Model: Model,
                        where: ctx.where,
                        data: update,
                        currentInstance: inst,
                        hookState: ctx.hookState,
                        options: options
                    };
                    Model.notifyObserversOf('persist', context, function (err) {
                        if (err) return done(err);
                        /**
                        * Dipayan: check for transaction object
                        */
                        if (options && options.transaction && options.transaction.connection) {
                            var opData = {};
                            opData.model = Model.modelName;
                            opData.op = 'updateOrCreate';
                            opData.filter = {};
                            opData.datasource = Model.dataSource.settings.database;
                            opData.connector = dataSource.connector;
                            opData.data = update;
                            opData._data = {};

                            if (!options.transaction.connection.opData)
                                options.transaction.connection.opData = [];
                            options.transaction.connection.opData.push(opData);
                            //options.transaction.connection.collections[model] = true;
                            done(null, update, null);

                        } else {
                            if (connector.updateOrCreate.length === 4) {
                                connector.updateOrCreate(Model.modelName, update, options, done);
                            } else {
                                connector.updateOrCreate(Model.modelName, update, done);
                            }
                        }

                    });
                }
                function done(err, data, info) {
                    if (err) {
                        return cb(err);
                    }
                    var context = {
                        Model: Model,
                        data: data,
                        hookState: ctx.hookState,
                        options: options
                    };
                    Model.notifyObserversOf('loaded', context, function (err) {
                        if (err) return cb(err);

                        var obj;
                        if (data && !(data instanceof Model)) {
                            inst._initProperties(data, { persisted: true });
                            obj = inst;
                        } else {
                            obj = data;
                        }
                        if (err) {
                            cb(err, obj);
                            if (!err) {
                                Model.emit('changed', inst);
                            }
                        } else {
                            var context = {
                                Model: Model,
                                instance: obj,
                                isNewInstance: info ? info.isNewInstance : undefined,
                                hookState: hookState,
                                options: options
                            };

                            Model.notifyObserversOf('after save', context, function (err) {
                                cb(err, obj);
                                if (!err) {
                                    Model.emit('changed', inst);
                                }
                            });
                        }
                    });
                }
            });
        } else {
            var opts = { notify: false };
            if (ctx.options && ctx.options.transaction) {
                opts.transaction = ctx.options.transaction;
            }
            Model.findOne({ where: ctx.query.where }, opts, function (err, inst) {
                if (err) {
                    return cb(err);
                }
                if (!isOriginalQuery) {
                    // The custom query returned from a hook may hide the fact that
                    // there is already a model with `id` value `data[idName(Model)]`
                    delete data[idName(Model)];
                }
                if (inst) {
                    inst.updateAttributes(data, options, cb);
                } else {
                    Model = self.lookupModel(data);
                    var obj = new Model(data);
                    obj.save(options, cb);
                }
            });
        }
    }
    return cb.promise;
};

/**
 * Find one record that matches specified query criteria.  Same as `find`, but limited to one record, and this function returns an
 * object, not a collection.
 * If the specified instance is not found, then create it using data provided as second argument.
 *
 * @param {Object} query Search conditions. See [find](#dataaccessobjectfindquery-callback) for query format.
 * For example: `{where: {test: 'me'}}`.
 * @param {Object} data Object to create.
 * @param {Object} [options] Option for findOrCreate
 * @param {Function} cb Callback called with (err, instance, created)
 */
DataAccessObject.findOrCreate = function findOrCreate(query, data, options, cb) {
    var dataSource = this.getDataSource(options);
    var connectionPromise = stillConnecting(dataSource, this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    assert(arguments.length >= 1, 'At least one argument is required');
    if (data === undefined && options === undefined && cb === undefined) {
        assert(typeof query === 'object', 'Single argument must be data object');
        // findOrCreate(data);
        // query will be built from data, and method will return Promise
        data = query;
        query = { where: data };
    } else if (options === undefined && cb === undefined) {
        if (typeof data === 'function') {
            // findOrCreate(data, cb);
            // query will be built from data
            cb = data;
            data = query;
            query = { where: data };
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            // findOrCreate(query, data, cb)
            cb = options;
            options = {};
        }
    }

    cb = cb || utils.createPromiseCallback();
    query = query || { where: {} };
    data = data || {};
    options = options || {};

    assert(typeof query === 'object', 'The query argument must be an object');
    assert(typeof data === 'object', 'The data argument must be an object');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    var hookState = {};

    var Model = this;
    var self = this;
    var connector = dataSource.connector;

    function _findOrCreate(query, data, currentInstance) {
        var modelName = self.modelName;
        function findOrCreateCallback(err, data, created) {
            var context = {
                Model: Model,
                data: data,
                isNewInstance: created,
                hookState: hookState,
                options: options
            };
            Model.notifyObserversOf('loaded', context, function (err) {
                if (err) return cb(err);

                var obj, Model = self.lookupModel(data);

                if (data) {
                    obj = new Model(data, {
                        fields: query.fields, applySetters: false,
                        persisted: true
                    });
                }

                if (created) {
                    var context = {
                        Model: Model,
                        instance: obj,
                        isNewInstance: true,
                        hookState: hookState,
                        options: options
                    };
                    Model.notifyObserversOf('after save', context, function (err) {
                        if (cb.promise) {
                            cb(err, [obj, created]);
                        } else {
                            cb(err, obj, created);
                        }
                        if (!err) Model.emit('changed', obj);
                    });

                } else {
                    if (cb.promise) {
                        cb(err, [obj, created]);
                    } else {
                        cb(err, obj, created);
                    }
                }
            });
        }

        data = removeUndefined(data);
        var context = {
            Model: Model,
            where: query.where,
            data: data,
            isNewInstance: true,
            currentInstance: currentInstance,
            hookState: hookState,
            options: options
        };

        Model.notifyObserversOf('persist', context, function (err) {
            if (err) return cb(err);

            if (connector.findOrCreate.length === 5) {
                connector.findOrCreate(modelName, query, self._forDB(context.data, dataSource), options, findOrCreateCallback);
            } else {
                connector.findOrCreate(modelName, query, self._forDB(context.data, dataSource), findOrCreateCallback);
            }
        });
    }

    if (connector.findOrCreate) {
        query.limit = 1;

        try {
            this._normalize(query, dataSource);
        } catch (err) {
            process.nextTick(function () {
                cb(err);
            });
            return cb.promise;
        }

        this.applyScope(query);

        var context = {
            Model: Model,
            query: query,
            hookState: hookState,
            options: options
        };
        Model.notifyObserversOf('access', context, function (err, ctx) {
            if (err) return cb(err);

            var query = ctx.query;

            var enforced = {};
            var Model = self.lookupModel(data);
            var obj = data instanceof Model ? data : new Model(data);

            Model.applyProperties(enforced, obj);
            obj.setAttributes(enforced);

            var context = {
                Model: Model,
                instance: obj,
                isNewInstance: true,
                hookState: hookState,
                options: options
            };
            Model.notifyObserversOf('before save', context, function (err, ctx) {
                if (err) return cb(err);

                var obj = ctx.instance;
                var data = obj.toObject(true);

                // validation required
                obj.isValid(function (valid) {
                    if (valid) {
                        _findOrCreate(query, data, obj);
                    } else {
                        cb(new ValidationError(obj), obj);
                    }
                }, options, data);
            });
        });
    } else {
        Model.findOne(query, options, function (err, record) {
            if (err) return cb(err);
            if (record) {
                if (cb.promise) {
                    return cb(null, [record, false]);
                } else {
                    return cb(null, record, false);
                }
            }
            Model.create(data, options, function (err, record) {
                if (cb.promise) {
                    cb(err, [record, record != null]);
                } else {
                    cb(err, record, record != null);
                }
            });
        });
    }
    return cb.promise;
};

/**
 * Check whether a model instance exists in database
 *
 * @param {id} id Identifier of object (primary key value)
 * @param {Object} [options] Options
 * @param {Function} cb Callback function called with (err, exists: Bool)
 */
DataAccessObject.exists = function exists(id, options, cb) {
    var connectionPromise = stillConnecting(this.getDataSource(options), this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    assert(arguments.length >= 1, 'The id argument is required');
    if (cb === undefined) {
        if (typeof options === 'function') {
            // exists(id, cb)
            cb = options;
            options = {};
        }
    }

    cb = cb || utils.createPromiseCallback();
    options = options || {};

    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    if (id !== undefined && id !== null && id !== '') {
        this.count(byIdQuery(this, id).where, options, function (err, count) {
            cb(err, err ? false : count === 1);
        });
    } else {
        process.nextTick(function () {
            cb(new Error('Model::exists requires the id argument'));
        });
    }
    return cb.promise;
};

/**
 * Find model instance by ID.
 *
 * Example:
 * ```js
 * User.findById(23, function(err, user) {
 *   console.info(user.id); // 23
 * });
 * ```
 *
 * @param {*} id Primary key value
 * @param {Object} [filter] The filter that contains `include` or `fields`.
 * Other settings such as `where`, `order`, `limit`, or `offset` will be
 * ignored.
 * @param {Object} [options] Options
 * @param {Function} cb Callback called with (err, instance)
 */
DataAccessObject.findById = function findById(id, filter, options, cb) {
    var connectionPromise = stillConnecting(this.getDataSource(options), this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    assert(arguments.length >= 1, 'The id argument is required');

    if (options === undefined && cb === undefined) {
        if (typeof filter === 'function') {
            // findById(id, cb)
            cb = filter;
            filter = {};
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            // findById(id, query, cb)
            cb = options;
            options = {};
            if (typeof filter === 'object' && !(filter.include || filter.fields)) {
                // If filter doesn't have include or fields, assuming it's options
                options = filter;
                filter = {};
            }
        }
    }

    cb = cb || utils.createPromiseCallback();
    options = options || {};
    filter = filter || {};

    if (checkOptions && Object.getOwnPropertyNames(options).length === 0) {
        console.trace('options is not being passed');
        process.exit(1);
    }

    assert(typeof filter === 'object', 'The filter argument must be an object');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    if (isPKMissing(this, cb)) {
        return cb.promise;
    } else if (id == null || id === '') {
        process.nextTick(function () {
            cb(new Error('Model::findById requires the id argument'));
        });
    } else {
        var query = byIdQuery(this, id);
        if (filter.where) {
            query.where = { and: [query.where, filter.where] };
        }
        if (filter.include) {
            query.include = filter.include;
        }
        if (filter.fields) {
            query.fields = filter.fields;
        }
        this.findOne(query, options, cb);
    }
    return cb.promise;
};

/**
 * Find model instances by ids
 * @param {Array} ids An array of ids
 * @param {Object} query Query filter
 * @param {Object} [options] Options
 * @param {Function} cb Callback called with (err, instance)
 */
DataAccessObject.findByIds = function (ids, query, options, cb) {
    if (options === undefined && cb === undefined) {
        if (typeof query === 'function') {
            // findByIds(ids, cb)
            cb = query;
            query = {};
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            // findByIds(ids, query, cb)
            cb = options;
            options = {};
        }
    }

    cb = cb || utils.createPromiseCallback();
    options = options || {};
    query = query || {};

    assert(Array.isArray(ids), 'The ids argument must be an array');
    assert(typeof query === 'object', 'The query argument must be an object');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    if (isPKMissing(this, cb)) {
        return cb.promise;
    } else if (ids.length === 0) {
        process.nextTick(function () { cb(null, []); });
        return cb.promise;
    }

    var filter = { where: {} };
    var pk = idName(this);
    filter.where[pk] = { inq: [].concat(ids) };
    mergeQuery(filter, query || {});

    // to know if the result need to be sorted by ids or not
    // this variable need to be initialized before the call to find, because filter is updated during the call with an order
    var toSortObjectsByIds = filter.order ? false : true;

    this.find(filter, options, function (err, results) {
        cb(err, toSortObjectsByIds ? utils.sortObjectsByIds(pk, ids, results) : results);
    });
    return cb.promise;
};

function convertNullToNotFoundError(ctx, cb) {
    if (ctx.result !== null) return cb();

    var modelName = ctx.method.sharedClass.name;
    var id = ctx.getArgByName('id');
    var msg = 'Unknown "' + modelName + '" id "' + id + '".';
    var error = new Error(msg);
    error.statusCode = error.status = 404;
    cb(error);
}

// alias function for backwards compat.
DataAccessObject.all = function () {
    return DataAccessObject.find.apply(this, arguments);
};

/**
 * Get settings via hiarchical determiniation
 *
 * @param {String} key The setting key
 */
DataAccessObject._getSetting = function (key, ds) {
    // Check for settings in model
    var m = this.definition;
    if (m && m.settings && m.settings[key]) {
        return m.settings[key];
    }

    // Check for settings in connector
    if (ds && ds.settings && ds.settings[key]) {
        return ds.settings[key];
    }

    return;
};

var operators = {
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    between: 'BETWEEN',
    inq: 'IN',
    nin: 'NOT IN',
    neq: '!=',
    like: 'LIKE',
    nlike: 'NOT LIKE',
    regexp: 'REGEXP'
};

/*
 * Normalize the filter object and throw errors if invalid values are detected
 * @param {Object} filter The query filter object
 * @returns {Object} The normalized filter object
 * @private
 */
DataAccessObject._normalize = function (filter, dataSource) {
    if (!filter) {
        return undefined;
    }
    var err = null;
    if ((typeof filter !== 'object') || Array.isArray(filter)) {
        err = new Error(util.format('The query filter %j is not an object', filter));
        err.statusCode = 400;
        throw err;
    }
    if (filter.limit || filter.skip || filter.offset) {
        var limit = Number(filter.limit || 100);
        var offset = Number(filter.skip || filter.offset || 0);
        if (isNaN(limit) || limit <= 0 || Math.ceil(limit) !== limit) {
            err = new Error(util.format('The limit parameter %j is not valid',
                filter.limit));
            err.statusCode = 400;
            throw err;
        }
        if (isNaN(offset) || offset < 0 || Math.ceil(offset) !== offset) {
            err = new Error(util.format('The offset/skip parameter %j is not valid',
                filter.skip || filter.offset));
            err.statusCode = 400;
            throw err;
        }
        filter.limit = limit;
        filter.offset = offset;
        filter.skip = offset;
    }

    if (filter.order) {
        var order = filter.order;
        if (!Array.isArray(order)) {
            order = [order];
        }
        var fields = [];
        for (var i = 0, m = order.length; i < m; i++) {
            if (typeof order[i] === 'string') {
                // Normalize 'f1 ASC, f2 DESC, f3' to ['f1 ASC', 'f2 DESC', 'f3']
                var tokens = order[i].split(/(?:\s*,\s*)+/);
                for (var t = 0, n = tokens.length; t < n; t++) {
                    var token = tokens[t];
                    if (token.length === 0) {
                        // Skip empty token
                        continue;
                    }
                    var parts = token.split(/\s+/);
                    if (parts.length >= 2) {
                        var dir = parts[1].toUpperCase();
                        if (dir === 'ASC' || dir === 'DESC') {
                            token = parts[0] + ' ' + dir;
                        } else {
                            err = new Error(util.format('The order %j has invalid direction', token));
                            err.statusCode = 400;
                            throw err;
                        }
                    }
                    fields.push(token);
                }
            } else {
                err = new Error(util.format('The order %j is not valid', order[i]));
                err.statusCode = 400;
                throw err;
            }
        }
        if (fields.length === 1 && typeof filter.order === 'string') {
            filter.order = fields[0];
        } else {
            filter.order = fields;
        }
    }

    // normalize fields as array of included property names
    if (filter.fields) {
        filter.fields = fieldsToArray(filter.fields,
            Object.keys(this.definition.properties), this.settings.strict);
    }

    var handleUndefined = this._getSetting('normalizeUndefinedInQuery', dataSource);
    // alter configuration of how removeUndefined handles undefined values
    filter = removeUndefined(filter, handleUndefined);
    this._coerce(filter.where);
    return filter;
};

function DateType(arg) {
    var d = new Date(arg);
    if (isNaN(d.getTime())) {
        throw new Error('Invalid date: ' + arg);
    }
    return d;
}

function BooleanType(arg) {
    if (typeof arg === 'string') {
        switch (arg) {
            case 'true':
            case '1':
                return true;
            case 'false':
            case '0':
                return false;
        }
    }
    if (arg == null) {
        return null;
    }
    return Boolean(arg);
}

function NumberType(val) {
    var num = Number(val);
    return !isNaN(num) ? num : val;
}

/*
 * Coerce values based the property types
 * @param {Object} where The where clause
 * @returns {Object} The coerced where clause
 * @private
 */
DataAccessObject._coerce = function (where) {
    var self = this;
    if (!where) {
        return where;
    }

    var err;
    if (typeof where !== 'object' || Array.isArray(where)) {
        err = new Error(util.format('The where clause %j is not an object', where));
        err.statusCode = 400;
        throw err;
    }

    var props = self.definition.properties;
    for (var p in where) {
        // Handle logical operators
        if (p === 'and' || p === 'or' || p === 'nor') {
            var clauses = where[p];
            if (Array.isArray(clauses)) {
                for (var k = 0; k < clauses.length; k++) {
                    self._coerce(clauses[k]);
                }
            } else {
                err = new Error(util.format('The %s operator has invalid clauses %j', p, clauses));
                err.statusCode = 400;
                throw err;
            }
            return where;
        }
        var DataType = props[p] && props[p].type;
        if (!DataType) {
            continue;
        }
        if (Array.isArray(DataType) || DataType === Array) {
            DataType = DataType[0];
        }
        if (DataType === Date) {
            DataType = DateType;
        } else if (DataType === Boolean) {
            DataType = BooleanType;
        } else if (DataType === Number) {
            // This fixes a regression in mongodb connector
            // For numbers, only convert it produces a valid number
            // LoopBack by default injects a number id. We should fix it based
            // on the connector's input, for example, MongoDB should use string
            // while RDBs typically use number
            DataType = NumberType;
        }

        if (!DataType) {
            continue;
        }

        if (DataType.prototype instanceof BaseModel) {
            continue;
        }

        if (DataType === geo.GeoPoint) {
            // Skip the GeoPoint as the near operator breaks the assumption that
            // an operation has only one property
            // We should probably fix it based on
            // http://docs.mongodb.org/manual/reference/operator/query/near/
            // The other option is to make operators start with $
            continue;
        }

        var val = where[p];
        if (val === null || val === undefined) {
            continue;
        }
        // Check there is an operator
        var operator = null;
        var exp = val;
        //below change to compare name is a quickfix and may cause issues for cases unknown to us yet.
        //this quickfix is to support node-red to work with EVF
        if (val.constructor.name === Object.name) {
            for (var op in operators) {
                if (op in val) {
                    val = val[op];
                    operator = op;
                    switch (operator) {
                        case 'inq':
                        case 'nin':
                            if (!Array.isArray(val)) {
                                err = new Error(util.format('The %s property has invalid clause %j', p, where[p]));
                                err.statusCode = 400;
                                throw err;
                            }
                            break;
                        case 'between':
                            if (!Array.isArray(val) || val.length !== 2) {
                                err = new Error(util.format('The %s property has invalid clause %j', p, where[p]));
                                err.statusCode = 400;
                                throw err;
                            }
                            break;
                        case 'like':
                        case 'nlike':
                            if (!(typeof val === 'string' || val instanceof RegExp)) {
                                err = new Error(util.format('The %s property has invalid clause %j', p, where[p]));
                                err.statusCode = 400;
                                throw err;
                            }
                            break;
                        case 'regexp':
                            val = utils.toRegExp(val);
                            if (val instanceof Error) {
                                val.statusCode = 400;
                                throw err;
                            }
                            break;
                    }
                    break;
                }
            }
        }
        // Coerce the array items
        if (Array.isArray(val)) {
            for (var i = 0; i < val.length; i++) {
                if (val[i] !== null && val[i] !== undefined) {
                    val[i] = DataType(val[i]);
                }
            }
        } else {
            if (val != null) {
                if (operator === null && val instanceof RegExp) {
                    // Normalize {name: /A/} to {name: {regexp: /A/}}
                    operator = 'regexp';
                } else if (operator === 'regexp' && val instanceof RegExp) {
                    // Do not coerce regex literals/objects
                } else if (!((operator === 'like' || operator === 'nlike') && val instanceof RegExp)) {
                    val = DataType(val);
                }
            }
        }
        // Rebuild {property: {operator: value}}
        if (operator) {
            var value = {};
            value[operator] = val;
            if (exp.options) {
                // Keep options for operators
                value.options = exp.options;
            }
            val = value;
        }
        where[p] = val;
    }
    return where;
};

/**
 * Find all instances of Model that match the specified query.
 * Fields used for filter and sort should be declared with `{index: true}` in model definition.
 * See [Querying models](http://docs.strongloop.com/display/DOC/Querying+models) for more information.
 *
 * For example, find the second page of ten users over age 21 in descending order exluding the password property.
 *
 * ```js
 * User.find({
 *   where: {
 *     age: {gt: 21}},
 *     order: 'age DESC',
 *     limit: 10,
 *     skip: 10,
 *     fields: {password: false}
 *   },
 *   console.log
 * );
 * ```
 *
 * @options {Object} [query] Optional JSON object that specifies query criteria and parameters.
 * @property {Object} where Search criteria in JSON format `{ key: val, key2: {gt: 'val2'}}`.
 * Operations:
 * - gt: >
 * - gte: >=
 * - lt: <
 * - lte: <=
 * - between
 * - inq: IN
 * - nin: NOT IN
 * - neq: !=
 * - like: LIKE
 * - nlike: NOT LIKE
 * - regexp: REGEXP
 *
 * You can also use `and` and `or` operations.  See [Querying models](http://docs.strongloop.com/display/DOC/Querying+models) for more information.
 * @property {String|Object|Array} include Allows you to load relations of several objects and optimize numbers of requests.
 * Format examples;
 * - `'posts'`: Load posts
 * - `['posts', 'passports']`: Load posts and passports
 * - `{'owner': 'posts'}`: Load owner and owner's posts
 * - `{'owner': ['posts', 'passports']}`: Load owner, owner's posts, and owner's passports
 * - `{'owner': [{posts: 'images'}, 'passports']}`: Load owner, owner's posts, owner's posts' images, and owner's passports
 * See `DataAccessObject.include()`.
 * @property {String} order Sort order.  Format: `'key1 ASC, key2 DESC'`
 * @property {Number} limit Maximum number of instances to return.
 * @property {Number} skip Number of instances to skip.
 * @property {Number} offset Alias for `skip`.
 * @property {Object|Array|String} fields Included/excluded fields.
 * - `['foo']` or `'foo'` - include only the foo property
 *  - `['foo', 'bar']` - include the foo and bar properties.  Format:
 *  - `{foo: true}` - include only foo
 * - `{bat: false}` - include all properties, exclude bat
 *
 * @param {Function} cb Required callback function.  Call this function with two arguments: `err` (null or Error) and an array of instances.
 */

DataAccessObject.find = function find(query, options, cb) {
    var dataSource = this.getDataSource(options);
    var connectionPromise = stillConnecting(dataSource, this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    if (options === undefined && cb === undefined) {
        if (typeof query === 'function') {
            // find(cb);
            cb = query;
            query = {};
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            // find(query, cb);
            cb = options;
            options = {};
        }
    }

    cb = cb || utils.createPromiseCallback();
    query = query || {};
    options = options || {};

    if (checkOptions && Object.getOwnPropertyNames(options).length === 0) {
        console.trace('options is not being passed');
        process.exit(1);
    }

    assert(typeof query === 'object', 'The query argument must be an object');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    var hookState = {};
    var self = this;
    var connector = dataSource.connector;

    assert(typeof connector.all === 'function',
        'all() must be implemented by the connector');

    try {
        this._normalize(query, dataSource);
    } catch (err) {
        process.nextTick(function () {
            cb(err);
        });
        return cb.promise;
    }

    this.applyScope(query);

    var near = query && geo.nearFilter(query.where);
    var supportsGeo = !!connector.buildNearFilter;

    if (near) {
        if (supportsGeo) {
            // convert it
            connector.buildNearFilter(query, near);
        } else if (query.where) {
            // do in memory query
            // using all documents
            // TODO [fabien] use default scope here?

            var context = {
                Model: self,
                query: query,
                hookState: hookState,
                options: options
            };
            self.notifyObserversOf('access', context, function (err, ctx) {
                if (err) return cb(err);

                function geoCallback(err, data) {
                    var memory = new Memory();
                    var modelName = self.modelName;

                    if (err) {
                        cb(err);
                    } else if (Array.isArray(data)) {
                        memory.define({
                            properties: self.dataSource.definitions[self.modelName].properties,
                            settings: self.dataSource.definitions[self.modelName].settings,
                            model: self
                        });

                        data.forEach(function (obj) {
                            memory.create(modelName, obj, options, function () {
                                // noop
                            });
                        });

                        // FIXME: apply "includes" and other transforms - see allCb below
                        memory.all(modelName, ctx.query, options, cb);
                    } else {
                        cb(null, []);
                    }
                }

                if (connector.all.length === 4) {
                    connector.all(self.modelName, {}, options, geoCallback);
                } else {
                    connector.all(self.modelName, {}, geoCallback);
                }
            });

            // already handled
            return cb.promise;
        }
    }

    // Caching related change
    // Author: Ajith Vasudevan
    // Declaring a function-level variable which will be assigned from within
    // the callback of "this.notifyObserversOf('access',...)" function.
    // The idea is to make the intercepting (custom) "allCb" function accessible
    // outside of this callback. This may not work, though.
    var allCb = null;

    // Caching related change
    // Author: Ajith Vasudevan
    // The previous "allCb" is renamed to "allCb2" below
    // This will be called from the custom "allCb" defined within
    // the callback of "this.notifyObserversOf('access',...)" function.
    var allCb2 = function (err, data) {
        var results = [];
        if (!err && Array.isArray(data)) {
            async.each(data, function (item, callback) {
                var d = item;//data[i];
                var Model = self.lookupModel(d);
                var obj = new Model(d, { fields: query.fields, applySetters: false, persisted: true });

                if (query && query.include) {
                    if (query.collect) {
                        // The collect property indicates that the query is to return the
                        // standalone items for a related model, not as child of the parent object
                        // For example, article.tags
                        obj = obj.__cachedRelations[query.collect];
                        if (obj === null) {
                            obj = undefined;
                        }
                    } else {
                        // This handles the case to return parent items including the related
                        // models. For example, Article.find({include: 'tags'}, ...);
                        // Try to normalize the include
                        var includes = Inclusion.normalizeInclude(query.include || []);
                        includes.forEach(function (inc) {
                            var relationName = inc;
                            if (utils.isPlainObject(inc)) {
                                relationName = Object.keys(inc)[0];
                            }

                            // Promote the included model as a direct property
                            var included = obj.__cachedRelations[relationName];
                            if (Array.isArray(included)) {
                                included = new List(included, null, obj);
                            }
                            if (included) obj.__data[relationName] = included;
                        });
                        delete obj.__data.__cachedRelations;
                    }
                }
                if (obj !== undefined) {
                    context = {
                        Model: Model,
                        instance: obj,
                        isNewInstance: false,
                        hookState: hookState,
                        options: options
                    };

                    Model.notifyObserversOf('loaded', context, function (err) {
                        if (err) return callback(err);

                        results.push(obj);
                        callback();
                    });
                } else {
                    callback();
                }
            },
                function (err) {
                    if (err) return cb(err);

                    if (data && data.countBeforeLimit) {
                        results.countBeforeLimit = data.countBeforeLimit;
                    }
                    if (!supportsGeo && near) {
                        results = geo.filter(results, near);
                    }

                    cb(err, results);
                });
        } else {
            cb(err, data || []);
        }
    };

    if (options.notify === false) {
        if (connector.all.length === 4) {
            connector.all(self.modelName, query, options, allCb || allCb2);
        } else {
            connector.all(self.modelName, query, allCb || allCb2);
        }
    } else {
        var context = {
            Model: this,
            query: query,
            hookState: hookState,
            options: options
        };
        this.notifyObserversOf('access', context, function (err, ctx) {
            if (err) return cb(err);

            // --------------------------Begin Caching related changes ---------------------------
            // Author: Ajith Vasudevan

            //copy the filter value into another variable to guard against
            //further changes. This copy is used for all caching purposes.
            var originalFilter = JSON.parse(JSON.stringify(ctx.query));

            //Defining an intercepting callback function here. ---------
            //This gets called after an actual DB query instead
            //of callback2 (see above). We call 'callback2' from
            //inside this intercepting function after caching
            //the results that we have intercepted.
            allCb = function (err, objs) {
                if (cacheable(self.modelName))   // Check if this model is actually marked as cacheable
                {
                    if (!err) // try to cache only if there are no errors from the DB
                    {
                        debug('EV_CACHE', 'originalFilter', originalFilter);
                        if (!originalFilter.include) {
                            debug('EV_CACHE', 'Intercepting callback function (err, objs): When returning from DB, this should cache:', self.modelName);
                            cache(self.modelName, originalFilter, objs);  // cache the intercepted results
                        } else {
                            debug('EV_CACHE', 'NOT Caching, as include filter is used in the current query (JIRA EV-383)', self.modelName);
                        }
                    }
                } else debug('EV_CACHE', 'Intercepting callback function (err, objs): When returning from DB, this should NOT cache:', self.modelName);

                // call the main 'callback2' which we have intercepted in this function
                allCb2(err, objs);
            };


            //Check if current model is marked as cacheable and if current key (filter)
            //is actually cached. If 'true', return from here and do not allow further execution
            //thereby preventing DB hit. The process of checking for cache key also returns
            //the cached data (if present) via callback2.
            //If 'false', no action is taken and the DB query is allowed to proceed normally.
            //However, after a successful DB query, we intercept the data and cache it. (see above
            //for intercepting function)
            if (cacheable(self.modelName) && cached(self.modelName, originalFilter, allCb2)) return;
            debug('EV_CACHE', 'Proceeding to query database for', self.modelName);
            // Atul : TODO - loaded hook will not be called for record. needs to work on.
            if (self.settings.compositeModels) {
                debug('EV_CACHE', 'Composite Model found. calling compositeGet(....) for', self.modelName, 'with query', query);
                compositeGet(self, query, options, allCb);
                return;
            }
            debug('EV_CACHE', 'Truly going to DB now for', self.modelName, 'with query', ctx.query);
            /*
             * The following is the implementation of an 'after accesss' hook which will
             * be replacing the same functionality implemented in ev-context-mixin.
             * The hook is named 'after accesss' (with the extra 's') so that it won't
             * clash with the mixin implementation which will be removed later.
             * Implementation is as follows:
             * In the below connector.all(...) function calls, the last parameter "allCb"
             * is replaced by a custom function that in turn calls 'allCb' after all 
             * 'after accesss' subscribers have returned.
             */
            connector.all.length === 4 ?
                connector.all(self.modelName, ctx.query, options,
                    function (err, objs) {
                        ctx.accdata = objs;
                        self.notifyObserversOf('after accesss', ctx, function (err, ctx) {
                            allCb(err, ctx.accdata);
                        });
                    }) :
                connector.all(self.modelName, ctx.query,
                    function (err, objs) {
                        ctx.accdata = objs;
                        self.notifyObserversOf('after accesss', ctx, function (err, ctx) {
                            allCb(err, ctx.accdata);
                        });
                    });
        });
    }
    return cb.promise;
};



//This function returns 'true' or 'false' depending upon whether the
//supplied filter (key) is available in the cache or not.
//Additionally, If the key is found in cache, a global object named
//"evcache", the function calls the supplied callback function
//with the results from cache.
function cached(model, filter, cb) {
    // module used to generate MD5 hash of the filter
    var crypto = require('crypto');

    // calculate the cache key as something like "modelname_fdgfy64744hfy7r64t44v4rfy63463"
    var key = model + '_' + crypto.createHash('md5').update(JSON.stringify(filter)).digest('hex');

    debug('EV_CACHE', 'function cached(model, filter, options, cb): Checking for cache: filter, key:', filter, key);
    if (global.evcache && global.evcache[key])   // Call callback with cached data if key exists in cache
    {
        debug('EV_CACHE', 'function cached(model, filter, options, cb): key found in cache: filter, key:', filter, key);
        cb(null, global.evcache[key]);
        return true;
    } else {
        debug('EV_CACHE', 'function cached(model, filter, options, cb): key not found in cache: filter, key:', filter, key);
        return false;
    }
}


//This function caches the supplied data (objs) against the supplied key (filter)
//optionally creating the cache object if it doesn't already exist.
function cache(model, filter, objs) {
    var crypto = require('crypto');
    var key = model + '_' + crypto.createHash('md5').update(JSON.stringify(filter)).digest('hex');

    if (!global.evcache) global.evcache = {};
    global.evcache[key] = objs;
    debug('EV_CACHE', 'function cache(model, filter, options, objs): CACHED THE DATA: filter, key:', filter, key);

}


//This function checks if the supplied modelname is marked as
//a cacheable entity or not and accordingly returns a boolean.
//It does this by checking if a member with the name as the modelname
//is available in a global "evcacheables" object and that its
//value is something other than 'false'.
function cacheable(model) {
    var result = false;
    if (global.evcacheables && global.evcacheables[model]) {
        debug('EV_CACHE', 'function cacheable(model): Model found to be cacheable:', model);
        result = true;
    } else debug('EV_CACHE', 'function cacheable(model): Model NOT cacheable:', model);
    return result;
}


//---------------------- End Cache Related changes ---------------------------------------


/**
 * Find one record, same as `find`, but limited to one result. This function returns an object, not a collection.
 *
 * @param {Object} query Search conditions.  See [find](#dataaccessobjectfindquery-callback) for query format.
 * For example: `{where: {test: 'me'}}`.
 * @param {Object} [options] Options
 * @param {Function} cb Callback function called with (err, instance)
 */
DataAccessObject.findOne = function findOne(query, options, cb) {
    var connectionPromise = stillConnecting(this.getDataSource(options), this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    if (options === undefined && cb === undefined) {
        if (typeof query === 'function') {
            cb = query;
            query = {};
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
    }

    if (checkOptions && Object.getOwnPropertyNames(options).length === 0) {
        console.trace('options is not being passed. Model is ', this.modelName, ' query is : ', JSON.stringify(query));
        try {
            throw new Error();
        } catch (newError) {
            console.trace(newError.stack);
            console.log(newError.stack);
        }
        process.exit(1);
    }

    cb = cb || utils.createPromiseCallback();
    query = query || {};
    options = options || {};

    assert(typeof query === 'object', 'The query argument must be an object');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    query.limit = 1;
    this.find(query, options, function (err, collection) {
        if (err || !collection || !collection.length > 0) return cb(err, null);
        cb(err, collection[0]);
    });
    return cb.promise;
};

/**
 * Destroy all matching records.
 * Delete all model instances from data source. Note: destroyAll method does not destroy hooks.
 * Example:
 *````js
 * Product.destroyAll({price: {gt: 99}}, function(err) {
   // removed matching products
 * });
 * ````
 *
 * @param {Object} [where] Optional object that defines the criteria.  This is a "where" object. Do NOT pass a filter object.
 * @param {Object) [options] Options
 * @param {Function} [cb] Callback called with (err, info)
 */
DataAccessObject.remove = DataAccessObject.deleteAll = DataAccessObject.destroyAll = function destroyAll(where, options, cb) {
    var dataSource = this.getDataSource(options);
    var connectionPromise = stillConnecting(dataSource, this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    var Model = this;
    var connector = dataSource.connector;

    assert(typeof connector.destroyAll === 'function',
        'destroyAll() must be implemented by the connector');

    if (options === undefined && cb === undefined) {
        if (typeof where === 'function') {
            cb = where;
            where = {};
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
    }

    cb = cb || utils.createPromiseCallback();
    where = where || {};
    options = options || {};

    if (checkOptions && Object.getOwnPropertyNames(options).length === 0) {
        console.trace('options is not being passed');
        process.exit(1);
    }

    assert(typeof where === 'object', 'The where argument must be an object');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    var hookState = {};

    var query = { where: where };
    this.applyScope(query);
    where = query.where;

    var context = {
        Model: Model,
        where: whereIsEmpty(where) ? {} : where,
        hookState: hookState,
        options: options
    };

    if (options.notify === false) {
        doDelete(where);
    } else {
        query = { where: whereIsEmpty(where) ? {} : where };
        var context = {
            Model: Model,
            query: query,
            hookState: hookState,
            options: options
        };
        Model.notifyObserversOf('access', context, function (err, ctx) {
            if (err) return cb(err);
            var context = {
                Model: Model,
                where: ctx.query.where,
                hookState: hookState,
                options: options
            };
            Model.notifyObserversOf('before delete', context, function (err, ctx) {
                if (err) return cb(err);
                doDelete(ctx.where);
            });
        });
    }

    function doDelete(where) {
        if (whereIsEmpty(where)) {
            if (connector.destroyAll.length === 4) {
                connector.destroyAll(Model.modelName, {}, options, done);
            } else {
                connector.destroyAll(Model.modelName, {}, done);
            }
        } else {
            try {
                // Support an optional where object
                where = removeUndefined(where);
                where = Model._coerce(where);
            } catch (err) {
                return process.nextTick(function () {
                    cb(err);
                });
            }

            if (connector.destroyAll.length === 4) {
                connector.destroyAll(Model.modelName, where, options, done);
            } else {
                connector.destroyAll(Model.modelName, where, done);
            }

        }

        function done(err, info) {
            if (err) return cb(err);

            if (options.notify === false) {
                return cb(err, info);
            }

            var context = {
                Model: Model,
                where: where,
                hookState: hookState,
                options: options
            };
            Model.notifyObserversOf('after delete', context, function (err) {
                cb(err, info);
                if (!err)
                    Model.emit('deletedAll', whereIsEmpty(where) ? undefined : where);
            });
        }
    }
    return cb.promise;
};

function whereIsEmpty(where) {
    return !where ||
        (typeof where === 'object' && Object.keys(where).length === 0);
}

/**
 * Delete the record with the specified ID.
 * Aliases are `destroyById` and `deleteById`.
 * @param {*} id The id value
 * @param {Function} cb Callback called with (err)
 */

// [FIXME] rfeng: This is a hack to set up 'deleteById' first so that
// 'deleteById' will be used as the name for strong-remoting to keep it backward
// compatible for angular SDK
DataAccessObject.removeById = DataAccessObject.destroyById = DataAccessObject.deleteById = function deleteById(id, options, cb) {
    var connectionPromise = stillConnecting(this.getDataSource(options), this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    assert(arguments.length >= 1, 'The id argument is required');
    if (cb === undefined) {
        if (typeof options === 'function') {
            // destroyById(id, cb)
            cb = options;
            options = {};
        }
    }

    options = options || {};
    cb = cb || utils.createPromiseCallback();

    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    if (isPKMissing(this, cb)) {
        return cb.promise;
    } else if (id == null || id === '') {
        process.nextTick(function () {
            cb(new Error('Model::deleteById requires the id argument'));
        });
        return cb.promise;
    }

    var Model = this;

    this.remove(byIdQuery(this, id).where, options, function (err, info) {
        if (err) return cb(err);
        var deleted = info && info.count > 0;
        if (Model.settings.strictDelete && !deleted) {
            err = new Error('No instance with id ' + id + ' found for ' + Model.modelName);
            err.code = 'NOT_FOUND';
            err.statusCode = 404;
            return cb(err);
        }

        cb(null, info);
        Model.emit('deleted', id);
    });
    return cb.promise;
};

/**
 * Return count of matched records. Optional query parameter allows you to count filtered set of model instances.
 * Example:
 *
 *```js
 * User.count({approved: true}, function(err, count) {
 *     console.log(count); // 2081
 * });
 * ```
 *
 * @param {Object} [where] Search conditions (optional)
 * @param {Object} [options] Options
 * @param {Function} cb Callback, called with (err, count)
 */
DataAccessObject.count = function (where, options, cb) {
    var dataSource = this.getDataSource(options);
    var connectionPromise = stillConnecting(dataSource, this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    if (options === undefined && cb === undefined) {
        if (typeof where === 'function') {
            // count(cb)
            cb = where;
            where = {};
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            // count(where, cb)
            cb = options;
            options = {};
        }
    }

    cb = cb || utils.createPromiseCallback();
    where = where || {};
    options = options || {};

    assert(typeof where === 'object', 'The where argument must be an object');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    var Model = this;
    var connector = dataSource.connector;
    assert(typeof connector.count === 'function',
        'count() must be implemented by the connector');
    assert(connector.count.length >= 3,
        'count() must take at least 3 arguments');

    var hookState = {};

    var query = { where: where };
    this.applyScope(query);
    where = query.where;

    try {
        where = removeUndefined(where);
        where = this._coerce(where);
    } catch (err) {
        process.nextTick(function () {
            cb(err);
        });
        return cb.promise;
    }

    var context = {
        Model: Model,
        query: { where: where },
        hookState: hookState,
        options: options
    };
    this.notifyObserversOf('access', context, function (err, ctx) {
        if (err) return cb(err);
        where = ctx.query.where;

        if (connector.count.length <= 3) {
            // Old signature, please note where is the last
            // count(model, cb, where)
            connector.count(Model.modelName, cb, where);
        } else {
            // New signature
            // count(model, where, options, cb)
            connector.count(Model.modelName, where, options, cb);
        }
    });
    return cb.promise;
};

/**
 * Save instance. If the instance does not have an ID, call `create` instead.
 * Triggers: validate, save, update or create.
 * @options {Object} options Optional options to use.
 * @property {Boolean} validate Default is true.
 * @property {Boolean} throws  Default is false.
 * @param {Function} cb Callback function with err and object arguments
 */
DataAccessObject.prototype.save = function (options, cb) {
    var dataSource = this.getDataSource(options);
    var connectionPromise = stillConnecting(dataSource, this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }
    var Model = this.constructor;

    if (typeof options === 'function') {
        cb = options;
        options = {};
    }

    cb = cb || utils.createPromiseCallback();
    options = options || {};

    assert(typeof options === 'object', 'The options argument should be an object');
    assert(typeof cb === 'function', 'The cb argument should be a function');

    if (isPKMissing(Model, cb)) {
        return cb.promise;
    } else if (this.isNewRecord()) {
        return Model.create(this, options, cb);
    }

    var hookState = {};

    if (options.validate === undefined) {
        options.validate = true;
    }
    if (options.throws === undefined) {
        options.throws = false;
    }

    var inst = this;
    var connector = dataSource.connector;
    var modelName = Model.modelName;

    var context = {
        Model: Model,
        instance: inst,
        hookState: hookState,
        options: options
    };
    Model.notifyObserversOf('before save', context, function (err) {
        if (err) return cb(err);

        var data = inst.toObject(true);
        Model.applyProperties(data, inst);
        inst.setAttributes(data);

        // validate first
        if (!options.validate) {
            return save();
        }

        inst.isValid(function (valid) {
            if (valid) {
                save();
            } else {
                var err = new ValidationError(inst);
                // throws option is dangerous for async usage
                if (options.throws) {
                    throw err;
                }
                cb(err, inst);
            }
        }, options);

        // then save
        function save() {
            inst.trigger('save', function (saveDone) {
                inst.trigger('update', function (updateDone) {
                    data = removeUndefined(data);
                    function saveCallback(err, unusedData, result) {
                        if (err) {
                            return cb(err, inst);
                        }

                        var context = {
                            Model: Model,
                            data: data,
                            isNewInstance: result && result.isNewInstance,
                            hookState: hookState,
                            options: options
                        };
                        Model.notifyObserversOf('loaded', context, function (err) {
                            if (err) return cb(err);

                            inst._initProperties(data, { persisted: true });

                            var context = {
                                Model: Model,
                                instance: inst,
                                isNewInstance: result && result.isNewInstance,
                                hookState: hookState,
                                options: options
                            };
                            Model.notifyObserversOf('after save', context, function (err) {
                                if (err) return cb(err, inst);
                                updateDone.call(inst, function () {
                                    saveDone.call(inst, function () {
                                        cb(err, inst);
                                        if (!err) {
                                            Model.emit('changed', inst);
                                        }
                                    });
                                });
                            });
                        });
                    }

                    context = {
                        Model: Model,
                        data: data,
                        where: byIdQuery(Model, getIdValue(Model, inst)).where,
                        currentInstance: inst,
                        hookState: hookState,
                        options: options
                    };

                    Model.notifyObserversOf('persist', context, function (err) {
                        if (err) return cb(err);

                        if (connector.save.length === 4) {
                            connector.save(modelName, inst.constructor._forDB(data, dataSource), options, saveCallback);
                        } else {
                            connector.save(modelName, inst.constructor._forDB(data, dataSource), saveCallback);
                        }
                    });

                }, data, cb);
            }, data, cb);
        }
    });
    return cb.promise;
};

/**
 * Update multiple instances that match the where clause
 *
 * Example:
 *
 *```js
 * Employee.update({managerId: 'x001'}, {managerId: 'x002'}, function(err) {
 *     ...
 * });
 * ```
 *
 * @param {Object} [where] Search conditions (optional)
 * @param {Object} data Changes to be made
 * @param {Object} [options] Options for update
 * @param {Function} cb Callback, called with (err, info)
 */
DataAccessObject.update =
    DataAccessObject.updateAll = function (where, data, options, cb) {
        var connectionPromise = stillConnecting(this.getDataSource(options), this, arguments);
        if (connectionPromise) {
            return connectionPromise;
        }

        assert(arguments.length >= 1, 'At least one argument is required');

        if (data === undefined && options === undefined && cb === undefined && arguments.length === 1) {
            data = where;
            where = {};
        } else if (options === undefined && cb === undefined) {
            // One of:
            // updateAll(data, cb)
            // updateAll(where, data) -> Promise
            if (typeof data === 'function') {
                cb = data;
                data = where;
                where = {};
            }

        } else if (cb === undefined) {
            // One of:
            // updateAll(where, data, options) -> Promise
            // updateAll(where, data, cb)
            if (typeof options === 'function') {
                cb = options;
                options = {};
            }
        }

        data = data || {};
        options = options || {};
        cb = cb || utils.createPromiseCallback();

        assert(typeof where === 'object', 'The where argument must be an object');
        assert(typeof data === 'object', 'The data argument must be an object');
        assert(typeof options === 'object', 'The options argument must be an object');
        assert(typeof cb === 'function', 'The cb argument must be a function');

        var Model = this;
        var connector = Model.getDataSource(options).connector;
        assert(typeof connector.update === 'function',
            'update() must be implemented by the connector');

        var hookState = {};

        var query = { where: where };
        this.applyScope(query);
        this.applyProperties(data);

        where = query.where;

        var context = {
            Model: Model,
            query: { where: where },
            hookState: hookState,
            options: options
        };
        Model.notifyObserversOf('access', context, function (err, ctx) {
            if (err) return cb(err);
            var context = {
                Model: Model,
                where: ctx.query.where,
                data: data,
                hookState: hookState,
                options: options
            };
            Model.notifyObserversOf('before save', context,
                function (err, ctx) {
                    if (err) return cb(err);
                    doUpdate(ctx.where, ctx.data);
                });
        });

        function doUpdate(where, data) {
            try {
                where = removeUndefined(where);
                where = Model._coerce(where);
                data = removeUndefined(data);
                data = Model._coerce(data);
            } catch (err) {
                return process.nextTick(function () {
                    cb(err);
                });
            }

            function updateCallback(err, info) {
                if (err) return cb(err);

                var context = {
                    Model: Model,
                    where: where,
                    data: data,
                    hookState: hookState,
                    options: options
                };
                Model.notifyObserversOf('after save', context, function (err, ctx) {
                    return cb(err, info);
                });
            }

            var context = {
                Model: Model,
                where: where,
                data: data,
                hookState: hookState,
                options: options
            };
            Model.notifyObserversOf('persist', context, function (err, ctx) {
                if (err) return cb(err);
                /**
                 * Dipayan: check for transaction object
                 */
                if (options && options.transaction && options.transaction.connection) {
                    var _where = _.cloneDeep(where);
                    var opts = { notify: false };
                    if (ctx.options && ctx.options.transaction) {
                        opts.transaction = ctx.options.transaction;
                    }
                    Model.findOne(_where, opts, function (err, res) {
                        if (err) {
                            return updateCallback(err);
                        }
                        var opData = {};
                        opData.model = Model.modelName;
                        opData.op = 'updateAll';
                        opData.filter = where;
                        opData.datasource = Model.dataSource.settings.database;
                        opData.connector = dataSource.connector;
                        opData.data = data;
                        opData._data = res.__data;
                        if (!options.transaction.connection.opData)
                            options.transaction.connection.opData = [];
                        options.transaction.connection.opData.push(opData);
                        return updateCallback(null, { count: 'Transaction in progress' });
                    });

                } else {
                    if (connector.update.length === 5) {
                        connector.update(Model.modelName, where, data, options, updateCallback);
                    } else {
                        connector.update(Model.modelName, where, data, updateCallback);
                    }
                }

            });
        }
        return cb.promise;
    };

DataAccessObject.prototype.isNewRecord = function () {
    return !this.__persisted;
};

/**
 * Return connector of current record
 * @private
 */
DataAccessObject.prototype.getConnector = function () {
    var dataSource = this.__dataSource || this.constructor.dataSource;
    return dataSource.connector;
};

/**
 * Delete object from persistence
 *
 * Triggers `destroy` hook (async) before and after destroying object
 *
 * @param {Object} [options] Options for delete
 * @param {Function} cb Callback
 */
DataAccessObject.prototype.remove =
    DataAccessObject.prototype.delete =
    DataAccessObject.prototype.destroy = function (options, cb) {
        var dataSource = this.getDataSource(options);
        var connectionPromise = stillConnecting(dataSource, this, arguments);
        if (connectionPromise) {
            return connectionPromise;
        }

        if (cb === undefined && typeof options === 'function') {
            cb = options;
            options = {};
        }

        cb = cb || utils.createPromiseCallback();
        options = options || {};

        assert(typeof options === 'object', 'The options argument should be an object');
        assert(typeof cb === 'function', 'The cb argument should be a function');

        var inst = this;
        var connector = dataSource.connector;

        var Model = this.constructor;
        var id = getIdValue(this.constructor, this);
        var hookState = {};

        if (isPKMissing(Model, cb))
            return cb.promise;

        var context = {
            Model: Model,
            query: byIdQuery(Model, id),
            hookState: hookState,
            options: options
        };

        Model.notifyObserversOf('access', context, function (err, ctx) {
            if (err) return cb(err);
            var context = {
                Model: Model,
                where: ctx.query.where,
                instance: inst,
                hookState: hookState,
                options: options
            };
            Model.notifyObserversOf('before delete', context, function (err, ctx) {
                if (err) return cb(err);
                doDeleteInstance(ctx.where);
            });
        });

        function doDeleteInstance(where) {
            if (!isWhereByGivenId(Model, where, id)) {
                // A hook modified the query, it is no longer
                // a simple 'delete model with the given id'.
                // We must switch to full query-based delete.
                Model.deleteAll(where, { notify: false }, function (err, info) {
                    if (err) return cb(err, false);
                    var deleted = info && info.count > 0;
                    if (Model.settings.strictDelete && !deleted) {
                        err = new Error('No instance with id ' + id + ' found for ' + Model.modelName);
                        err.code = 'NOT_FOUND';
                        err.statusCode = 404;
                        return cb(err, false);
                    }
                    var context = {
                        Model: Model,
                        where: where,
                        instance: inst,
                        hookState: hookState,
                        options: options
                    };
                    Model.notifyObserversOf('after delete', context, function (err) {
                        cb(err, info);
                        if (!err) Model.emit('deleted', id);
                    });
                });
                return;
            }

            inst.trigger('destroy', function (destroyed) {
                function destroyCallback(err, info) {
                    if (err) return cb(err);
                    var deleted = info && info.count > 0;
                    if (Model.settings.strictDelete && !deleted) {
                        err = new Error('No instance with id ' + id + ' found for ' + Model.modelName);
                        err.code = 'NOT_FOUND';
                        err.statusCode = 404;
                        return cb(err);
                    }

                    destroyed(function () {
                        var context = {
                            Model: Model,
                            where: where,
                            instance: inst,
                            hookState: hookState,
                            options: options
                        };
                        Model.notifyObserversOf('after delete', context, function (err) {
                            cb(err, info);
                            if (!err) Model.emit('deleted', id);
                        });
                    });
                }

                if (connector.destroy.length === 4) {
                    connector.destroy(inst.constructor.modelName, id, options, destroyCallback);
                } else {
                    connector.destroy(inst.constructor.modelName, id, destroyCallback);
                }
            }, null, cb);
        }
        return cb.promise;
    };

/**
 * Set a single attribute.
 * Equivalent to `setAttributes({name: value})`
 *
 * @param {String} name Name of property
 * @param {Mixed} value Value of property
 */
DataAccessObject.prototype.setAttribute = function setAttribute(name, value) {
    this[name] = value; // TODO [fabien] - currently not protected by applyProperties
};

/**
 * Update a single attribute.
 * Equivalent to `updateAttributes({name: value}, cb)`
 *
 * @param {String} name Name of property
 * @param {Mixed} value Value of property
 * @param {Function} cb Callback function called with (err, instance)
 */
DataAccessObject.prototype.updateAttribute = function updateAttribute(name, value, options, cb) {
    var data = {};
    data[name] = value;
    return this.updateAttributes(data, options, cb);
};

/**
 * Update set of attributes.
 *
 * @trigger `change` hook
 * @param {Object} data Data to update
 */
DataAccessObject.prototype.setAttributes = function setAttributes(data) {
    if (typeof data !== 'object') return;

    this.constructor.applyProperties(data, this);

    var Model = this.constructor;
    var inst = this;

    // update instance's properties
    for (var key in data) {
        inst.setAttribute(key, data[key]);
    }

    Model.emit('set', inst);
};

DataAccessObject.prototype.unsetAttribute = function unsetAttribute(name, nullify) {
    if (nullify || this.constructor.definition.settings.persistUndefinedAsNull) {
        this[name] = this.__data[name] = null;
    } else {
        delete this[name];
        delete this.__data[name];
    }
};

/**
 * Update set of attributes.
 * Performs validation before updating.
 *
 * @trigger `validation`, `save` and `update` hooks
 * @param {Object} data Data to update
 * @param {Object} [options] Options for updateAttributes
 * @param {Function} cb Callback function called with (err, instance)
 */
DataAccessObject.prototype.updateAttributes = function updateAttributes(data, options, cb) {
    var dataSource = this.getDataSource(options);
    var connectionPromise = stillConnecting(dataSource, this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    if (options === undefined && cb === undefined) {
        if (typeof data === 'function') {
            // updateAttributes(cb)
            cb = data;
            data = undefined;
        }
    } else if (cb === undefined) {
        if (typeof options === 'function') {
            // updateAttributes(data, cb)
            cb = options;
            options = {};
        }
    }

    cb = cb || utils.createPromiseCallback();
    options = options || {};

    if (checkOptions && Object.getOwnPropertyNames(options).length === 0) {
        console.trace('options is not being passed');
        process.exit(1);
    }

    assert((typeof data === 'object') && (data !== null),
        'The data argument must be an object');
    assert(typeof options === 'object', 'The options argument must be an object');
    assert(typeof cb === 'function', 'The cb argument must be a function');

    var inst = this;
    var Model = this.constructor;
    var connector = dataSource.connector;
    assert(typeof connector.updateAttributes === 'function',
        'updateAttributes() must be implemented by the connector');

    if (isPKMissing(Model, cb))
        return cb.promise;

    var allowExtendedOperators = connector.settings &&
        connector.settings.allowExtendedOperators;

    var strict = this.__strict;
    var model = Model.modelName;
    var hookState = {};

    // Convert the data to be plain object so that update won't be confused
    if (data instanceof Model) {
        data = data.toObject(false);
    }
    data = removeUndefined(data);

    // Make sure id(s) cannot be changed
    var idNames = Model.definition.idNames();
    for (var i = 0, n = idNames.length; i < n; i++) {
        var idName = idNames[i];
        if (data[idName] !== undefined && !idEquals(data[idName], inst[idName])) {
            var err = new Error('id property (' + idName + ') ' +
                'cannot be updated from ' + inst[idName] + ' to ' + data[idName]);
            err.statusCode = 400;
            process.nextTick(function () {
                cb(err);
            });
            return cb.promise;
        }
    }

    var context = {
        Model: Model,
        where: byIdQuery(Model, getIdValue(Model, inst)).where,
        data: data,
        currentInstance: inst,
        hookState: hookState,
        options: options
    };

    Model.notifyObserversOf('before save', context, function (err, ctx) {
        if (err) return cb(err);
        if (!ctx.data && ctx.instanceUpdated) {
            return cb(null, ctx.updatedInstance);
        }
        data = ctx.data;

        if (strict && !allowExtendedOperators) {
            var props = Model.definition.properties;
            var keys = Object.keys(data);
            var result = {}, key;
            for (var i = 0; i < keys.length; i++) {
                key = keys[i];
                if (props[key]) {
                    result[key] = data[key];
                } else if (strict === 'throw') {
                    cb(new Error('Unknown property: ' + key));
                    return;
                } else if (strict === 'validate') {
                    inst.__unknownProperties.push(key);
                }
            }
            data = removeUndefined(result);
        }

        // update instance's properties
        inst.setAttributes(data);

        inst.isValid(function (valid) {
            if (!valid) {
                cb(new ValidationError(inst), inst);
                return;
            }

            inst.trigger('save', function (saveDone) {
                inst.trigger('update', function (done) {
                    var typedData = {};

                    for (var key in data) {
                        // Convert the properties by type
                        inst[key] = data[key];
                        typedData[key] = inst[key];
                        if (typeof typedData[key] === 'object' &&
                            typedData[key] !== null &&
                            typeof typedData[key].toObject === 'function') {
                            typedData[key] = typedData[key].toObject();
                        }
                    }

                    context.data = typedData;

                    function updateAttributesCallback(err) {
                        if (err) {
                            return cb(err);
                        }
                        var ctx = {
                            Model: Model,
                            data: context.data,
                            hookState: hookState,
                            options: options
                        };
                        Model.notifyObserversOf('loaded', ctx, function (err) {
                            if (err) return cb(err);

                            inst.__persisted = true;

                            // By default, the instance passed to updateAttributes callback is NOT updated
                            // with the changes made through persist/loaded hooks. To preserve
                            // backwards compatibility, we introduced a new setting updateOnLoad,
                            // which if set, will apply these changes to the model instance too.
                            if (Model.settings.updateOnLoad) {
                                inst.setAttributes(ctx.data);
                            }
                            done.call(inst, function () {
                                saveDone.call(inst, function () {
                                    if (err) return cb(err, inst);

                                    var context = {
                                        Model: Model,
                                        instance: inst,
                                        isNewInstance: false,
                                        hookState: hookState,
                                        options: options
                                    };
                                    Model.notifyObserversOf('after save', context, function (err) {
                                        if (!err) Model.emit('changed', inst);
                                        cb(err, inst);
                                    });
                                });
                            });
                        });
                    }

                    var ctx = {
                        Model: Model,
                        where: byIdQuery(Model, getIdValue(Model, inst)).where,
                        data: context.data,
                        currentInstance: inst,
                        hookState: hookState,
                        options: options
                    };
                    Model.notifyObserversOf('persist', ctx, function (err) {
                        /**
                         * Dipayan: check for transaction object
                         */
                        if (options && options.transaction && options.transaction.connection) {
                            var id = getIdValue(inst.constructor, inst);
                            var query = byIdQuery(Model, id);
                            Model.findOne({ where: query.where }, options, function (err, res) {
                                if (err) {
                                    return updateAttributesCallback(err);
                                }
                                var opData = {};
                                opData.model = Model.modelName;
                                opData.op = 'updateAttributes';
                                opData.filter = id;
                                opData.datasource = Model.dataSource.settings.database;
                                opData.connector =  dataSource.connector;
                                opData.data = inst.constructor._forDB(context.data, dataSource);
                                opData._data = res.__data;
                                if (!options.transaction.connection.opData)
                                    options.transaction.connection.opData = [];
                                options.transaction.connection.opData.push(opData);
                                return updateAttributesCallback(null, {});
                            });

                        } else {
                            if (connector.updateAttributes.length === 5) {
                                connector.updateAttributes(model, getIdValue(inst.constructor, inst),
                                    inst.constructor._forDB(context.data, dataSource), options, updateAttributesCallback);
                            } else {
                                connector.updateAttributes(model, getIdValue(inst.constructor, inst),
                                    inst.constructor._forDB(context.data, dataSource), updateAttributesCallback);
                            }
                        }
                    });
                }, data, cb);
            }, data, cb);
        }, options, data);
    });
    return cb.promise;
};

/**
 * Reload object from persistence
 * Requires `id` member of `object` to be able to call `find`
 * @param {Function} cb Called with (err, instance) arguments
 * @private
 */
DataAccessObject.prototype.reload = function reload(options, cb) {
    var connectionPromise = stillConnecting(this.getDataSource(options), this, arguments);
    if (connectionPromise) {
        return connectionPromise;
    }

    return this.constructor.findById(getIdValue(this.constructor, this), options, cb);
};


/*
 * Define readonly property on object
 *
 * @param {Object} obj
 * @param {String} key
 * @param {Mixed} value
 * @private
 */
function defineReadonlyProp(obj, key, value) {
    Object.defineProperty(obj, key, {
        writable: false,
        enumerable: true,
        configurable: true,
        value: value
    });
}

var defineScope = require('./scope.js').defineScope;

/**
 * Define a scope for the model class. Scopes enable you to specify commonly-used
 * queries that you can reference as method calls on a model.
 *
 * @param {String} name The scope name
 * @param {Object} query The query object for DataAccessObject.find()
 * @param {ModelClass} [targetClass] The model class for the query, default to
 * the declaring model
 */
DataAccessObject.scope = function (name, query, targetClass, methods, options) {
    var cls = this;
    if (options && options.isStatic === false) {
        cls = cls.prototype;
    }
    return defineScope(cls, targetClass || cls, name, query, methods, options);
};

/*
 * Add 'include'
 */
jutil.mixin(DataAccessObject, Inclusion);

/*
 * Add 'relation'
 */
jutil.mixin(DataAccessObject, Relation);

/*
 * Add 'transaction'
 */
jutil.mixin(DataAccessObject, require('./transaction'));

function PKMissingError(modelName) {
    this.name = 'PKMissingError';
    this.message = 'Primary key is missing for the ' + modelName + ' model';
}
PKMissingError.prototype = new Error();

function isPKMissing(modelClass, cb) {
    var hasPK = modelClass.definition.hasPK();
    if (hasPK) return false;
    process.nextTick(function () {
        cb(new PKMissingError(modelClass.modelName));
    });
    return true;
}
var getKeys = function dataAccessGetKeys(data, arr) {
    _.forEach(data, function dataAccessGetKeysForEach(value, key) {
        if ((typeof key === 'string') && (key !== 'and' || key !== 'or')) {
            if (key.indexOf('.') > -1) {
                Array.prototype.splice.apply(arr, [0, 0].concat(key.split('.')));
            } else {
                arr.push(key);
            }
        }
        if (typeof value === 'object') {

            getKeys(value, arr);
        }

    });
};
