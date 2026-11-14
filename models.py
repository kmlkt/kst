from tortoise.models import Model
from tortoise import fields


class Device(Model):
    tag = fields.TextField(primary_key=True)
    name = fields.TextField()
    model = fields.TextField()
    
class Parameter(Model):
    id = fields.IntField(primary_key=True)
    device = fields.ForeignKeyField(to="models.Device", related_name="parameters")
    parameter = fields.TextField()
    value = fields.FloatField()
    class Meta:
        unique_together = (("device", "parameter"),)

class User(Model):
    email = fields.TextField(primary_key=True)
    password_hash = fields.TextField()



