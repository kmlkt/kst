import itertools
import pydantic
import csv


class ParameterMeta(pydantic.BaseModel):
    model: str = pydantic.Field(validation_alias="Модель")
    parameter: str = pydantic.Field(validation_alias="Параметр")
    unit: str = pydantic.Field(validation_alias="Единица измерения")
    minimum: float | None = pydantic.Field(validation_alias="Минимум")
    minimum_warning: float | None = pydantic.Field(validation_alias="Минимум пред")
    norm: float | None = pydantic.Field(validation_alias="Норма")
    maximum_warning: float | None = pydantic.Field(validation_alias="Максимум пред")
    maximum: float | None = pydantic.Field(validation_alias="Максимум")



def load_csv(path: str):
    with open(path, encoding="utf-8-sig", newline="") as f:
            return [ParameterMeta.model_validate({
                    key: value if value != "" else None
                    for key, value in row.items()
                }) for row in csv.DictReader(f, delimiter=';')]
    

PARAMETERS_META = {model: {param.parameter: param 
                           for param in group} 
                   for model, group in itertools.groupby(load_csv("parameters.csv"), lambda x:x.model)}