(function() {
  'use strict';

  angular.module("firebase")

    // The factory returns an object containing the value of the data at
    // the Firebase location provided, as well as several methods. It
    // takes one or two arguments:
    //
    //   * `ref`: A Firebase reference. Queries or limits may be applied.
    //   * `config`: An object containing any of the advanced config options explained in API docs
    .factory("$firebase", [ "$firebaseUtils", "$firebaseConfig",
      function ($firebaseUtils, $firebaseConfig) {
        function AngularFire(ref, config) {
          // make the new keyword optional
          if (!(this instanceof AngularFire)) {
            return new AngularFire(ref, config);
          }
          this._config = $firebaseConfig(config);
          this._ref = ref;
          this._arraySync = null;
          this._objectSync = null;
          this._assertValidConfig(ref, this._config);
        }

        AngularFire.prototype = {
          $ref: function () {
            return this._ref;
          },

          $push: function (data) {
            var def = $firebaseUtils.defer();
            var ref = this._ref.ref().push();
            var done = this._handle(def, ref);
            if (arguments.length > 0) {
              ref.set(data, done);
            }
            else {
              done();
            }
            return def.promise;
          },

          $set: function (key, data) {
            var ref = this._ref;
            var def = $firebaseUtils.defer();
            if (arguments.length > 1) {
              ref = ref.ref().child(key);
            }
            else {
              data = key;
            }
            if( angular.isFunction(ref.set) || !angular.isObject(data) ) {
              // this is not a query, just do a flat set
              ref.ref().set(data, this._handle(def, ref));
            }
            else {
              // this is a query, so we will replace all the elements
              // of this query with the value provided, but not blow away
              // the entire Firebase path
              ref.once('value', function(snap) {
                snap.forEach(function(ss) {
                  if( !data.hasOwnProperty(ss.name()) ) {
                    data[ss.name()] = null;
                  }
                });
                ref.ref().update(data, this._handle(def, ref));
              }, this);
            }
            return def.promise;
          },

          $remove: function (key) {
            var ref = this._ref;
            if (arguments.length > 0) {
              ref = ref.ref().child(key);
            }
            var def = $firebaseUtils.defer();
            if( angular.isFunction(ref.remove) ) {
              // this is not a query, just do a flat remove
              ref.remove(this._handle(def, ref));
            }
            else {
              var promises = [];
              // this is a query so let's only remove the
              // items in the query and not the entire path
              ref.once('value', function(snap) {
                snap.forEach(function(ss) {
                  var d = $firebaseUtils.defer();
                  promises.push(d);
                  ss.ref().remove(this._handle(d, ss.ref()));
                }, this);
              });
              this._handle($q.all(promises), ref);
            }
            return def.promise;
          },

          $update: function (key, data) {
            var ref = this._ref.ref();
            var def = $firebaseUtils.defer();
            if (arguments.length > 1) {
              ref = ref.child(key);
            }
            else {
              data = key;
            }
            ref.update(data, this._handle(def, ref));
            return def.promise;
          },

          $transaction: function (key, valueFn, applyLocally) {
            var ref = this._ref.ref();
            if( angular.isFunction(key) ) {
              applyLocally = valueFn;
              valueFn = key;
            }
            else {
              ref = ref.child(key);
            }
            if( angular.isUndefined(applyLocally) ) {
              applyLocally = false;
            }

            var def = $firebaseUtils.defer();
            ref.transaction(valueFn, function(err, committed, snap) {
               if( err ) {
                 def.reject(err);
               }
               else {
                 def.resolve(committed? snap : null);
               }
            }, applyLocally);
            return def.promise;
          },

          $asObject: function () {
            if (!this._objectSync || this._objectSync.isDestroyed) {
              this._objectSync = new SyncObject(this, this._config.objectFactory);
            }
            return this._objectSync.getObject();
          },

          $asArray: function () {
            if (!this._arraySync || this._arraySync.isDestroyed) {
              this._arraySync = new SyncArray(this, this._config.arrayFactory);
            }
            return this._arraySync.getArray();
          },

          _handle: function (def) {
            var args = Array.prototype.slice.call(arguments, 1);
            return function (err) {
              if (err) {
                def.reject(err);
              }
              else {
                def.resolve.apply(def, args);
              }
            };
          },

          _assertValidConfig: function (ref, cnf) {
            $firebaseUtils.assertValidRef(ref, 'Must pass a valid Firebase reference ' +
              'to $firebase (not a string or URL)');
            if (!angular.isFunction(cnf.arrayFactory)) {
              throw new Error('config.arrayFactory must be a valid function');
            }
            if (!angular.isFunction(cnf.objectFactory)) {
              throw new Error('config.arrayFactory must be a valid function');
            }
          }
        };

        function SyncArray($inst, ArrayFactory) {
          function destroy() {
            self.isDestroyed = true;
            var ref = $inst.$ref();
            ref.off('child_added', created);
            ref.off('child_moved', moved);
            ref.off('child_changed', updated);
            ref.off('child_removed', removed);
            array = null;
          }

          function init() {
            var ref = $inst.$ref();

            // listen for changes at the Firebase instance
            ref.on('child_added', created, error);
            ref.on('child_moved', moved, error);
            ref.on('child_changed', updated, error);
            ref.on('child_removed', removed, error);
          }

          var array = new ArrayFactory($inst, destroy);
          var batch = $firebaseUtils.batch();
          var created = batch(array.$$added, array);
          var updated = batch(array.$$updated, array);
          var moved = batch(array.$$moved, array);
          var removed = batch(array.$$removed, array);
          var error = batch(array.$$error, array);

          var self = this;
          self.isDestroyed = false;
          self.getArray = function() { return array; };
          init();
        }

        function SyncObject($inst, ObjectFactory) {
          function destroy() {
            self.isDestroyed = true;
            ref.off('value', applyUpdate);
            obj = null;
          }

          function init() {
            ref.on('value', applyUpdate, error);
          }

          var obj = new ObjectFactory($inst, destroy);
          var ref = $inst.$ref();
          var batch = $firebaseUtils.batch();
          var applyUpdate = batch(obj.$$updated, obj);
          var error = batch(obj.$$error, obj);

          var self = this;
          self.isDestroyed = false;
          self.getObject = function() { return obj; };
          init();
        }

        return AngularFire;
      }
    ]);
})();