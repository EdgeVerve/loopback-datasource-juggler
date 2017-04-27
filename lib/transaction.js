/**
 * 
 * ©2016-2017 EdgeVerve Systems Limited (a fully owned Infosys subsidiary),
 * Bangalore, India. All Rights Reserved.
 * 
 */

var debug = require('debug')('loopback:connector:transaction');
var uuid = require('node-uuid');
var utils = require('./utils');
var jutil = require('./jutil');
var ObserverMixin = require('./observer');

var Transaction = require('./transaction-ex.js');

module.exports = TransactionMixin;

/**
 * TransactionMixin class.  Use to add transaction APIs to a model class.
 *
 * @class TransactionMixin
 */
function TransactionMixin() {
}

/**
 * Begin a new transaction
 * @param {Object|String} [options] Options can be one of the forms:
 * - Object: {isolationLevel: '...', timeout: 1000}
 * - String: isolationLevel
 *
 * Valid values of `isolationLevel` are:
 *
 * - Transaction.READ_COMMITTED = 'READ COMMITTED'; // default
 * - Transaction.READ_UNCOMMITTED = 'READ UNCOMMITTED';
 * - Transaction.SERIALIZABLE = 'SERIALIZABLE';
 * - Transaction.REPEATABLE_READ = 'REPEATABLE READ';
 *
 * @param {Function} cb Callback function. It calls back with (err, transaction).
 * To pass the transaction context to one of the CRUD methods, use the `options`
 * argument with `transaction` property, for example,
 *
 * ```js
 *
 * MyModel.beginTransaction('READ COMMITTED', function(err, tx) {
 *   MyModel.create({x: 1, y: 'a'}, {transaction: tx}, function(err, inst) {
 *     MyModel.find({x: 1}, {transaction: tx}, function(err, results) {
 *       // ...
 *       tx.commit(function(err) {...});
 *     });
 *   });
 * });
 * ```
 *
 * The transaction can be committed or rolled back. If timeout happens, the
 * transaction will be rolled back. Please note a transaction is typically
 * associated with a pooled connection. Committing or rolling back a transaction
 * will release the connection back to the pool.
 *
 * Once the transaction is committed or rolled back, the connection property
 * will be set to null to mark the transaction to be inactive. Trying to commit
 * or rollback an inactive transaction will receive an error from the callback.
 *
 * Please also note that the transaction is only honored with the same data
 * source/connector instance. CRUD methods will not join the current transaction
 * if its model is not attached the same data source.
 *
 */
TransactionMixin.beginTransaction = function (options, cb) {

    if (cb === undefined) {
        if (typeof options === 'function') {
            cb = options;
            options = {};
        }
    }

    cb = cb || utils.createPromiseCallback();

    if (Transaction) {
        var connector = this.getConnector(options);
        //Callback function for begin transaction
        function txnCallback(err, transaction) {
            if (err) return cb(err);
            if (transaction) {
                // Set an informational transaction id
                transaction.id = uuid.v1();
            }
            if (options.timeout) {
                setTimeout(function () {
                    var context = {
                        transaction: transaction,
                        operation: 'timeout'
                    };
                    transaction.notifyObserversOf('timeout', context, function (err) {
                        if (!err) {
                            transaction.rollback(function () {
                                debug('Transaction %s is rolled back due to timeout',
                  transaction.id);
                            });
                        }
                    });
                }, options.timeout);
            }
            cb(err, transaction);
        };
        //Following function returns in-built/default transaction implementation of connector
        function getTransaction(txn) {
            var prevTxn = txn;

            txn = require('loopback-connector').Transaction;
            jutil.mixin(txn.prototype, ObserverMixin);
            txn.prototype.commit = prevTxn.prototype.commit;
            txn.prototype.rollback = prevTxn.prototype.rollback;
            txn.prototype.toJSON = prevTxn.prototype.toJSON;
            txn.prototype.toString = prevTxn.prototype.toString;

            return txn;
        }

        if (connector.relational) {
            //retrieving default transaction implementation of connector for relational database
            Transaction = getTransaction(Transaction);
            Transaction.begin(connector, options, txnCallback);
        } else {
            var loopback = require('loopback');
            var dbTxn = loopback.getModel('DbTransaction').getDataSource(options).connector;
            Transaction.begin(connector, dbTxn, options, txnCallback);
        }
    } else {
        process.nextTick(function () {
            var err = new Error('Transaction is not supported');
            cb(err);
        });
    }
    return cb.promise;
};

// Promisify the transaction apis
if (Transaction) {
    jutil.mixin(Transaction.prototype, ObserverMixin);
    /**
   * Commit a transaction and release it back to the pool
   * @param {Function} cb Callback function
   * @returns {Promise|undefined}
   */
    Transaction.prototype.commit = function (options, cb) {
        if (cb === undefined) {
            if (typeof options === 'function') {
                cb = options;
                options = {};
            }
        }

        var self = this;
        cb = cb || utils.createPromiseCallback();
        // Report an error if the transaction is not active
        if (!self.connection) {
            process.nextTick(function () {
                cb(new Error('The transaction is not active: ' + self.id));
            });
            return cb.promise;
        }
        var context = {
            transaction: self,
            operation: 'commit'
        };

        function work(done) {
            if (self.connector.relational) {
                //default transaction implementation of connector for relational database

                self.connector.commit(self.connection, done);
            } else {
                self.doCommit(options, done);
            }
        }

        self.notifyObserversAround('commit', context, work, function (err) {
            // Deference the connection to mark the transaction is not active
            // The connection should have been released back the pool
            self.connection = null;
            cb(err);
        });

        return cb.promise;
    };

    /**
   * Rollback a transaction and release it back to the pool
   * @param {Function} cb Callback function
   * @returns {Promise|undefined}
   */
    Transaction.prototype.rollback = function (options, cb) {
        if (cb === undefined) {
            if (typeof options === 'function') {
                cb = options;
                options = {};
            }
        }

        var self = this;
        cb = cb || utils.createPromiseCallback();
        // Report an error if the transaction is not active
        if (!self.connection) {
            process.nextTick(function () {
                cb(new Error('The transaction is not active: ' + self.id));
            });
            return cb.promise;
        }
        var context = {
            transaction: self,
            operation: 'rollback'
        };

        function work(done) {
            if (self.connector.relational) {
                //default transaction implementation of connector for relational database
                self.connector.rollback(self.connection, done);
            } else {
                self.doRollback(options, done);
            }
        }

        self.notifyObserversAround('rollback', context, work, function (err) {
            // Deference the connection to mark the transaction is not active
            // The connection should have been released back the pool
            self.connection = null;
            cb(err);
        });

        return cb.promise;
    };

    Transaction.prototype.toJSON = function () {
        return this.id;
    };

    Transaction.prototype.toString = function () {
        return this.id;
    };
}

TransactionMixin.Transaction = Transaction;
